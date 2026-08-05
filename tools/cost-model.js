#!/usr/bin/env node
/**
 * cost-model.js — cost per thousand queries against QPS, and the crossover
 * against a managed vector store.
 *
 * The single most useful chart this project can produce, because it is the one
 * that answers "do you understand cloud economics" rather than "did you deploy
 * something".
 *
 * The shape comes from the split-tier design. The consensus tier is a fixed
 * floor: the EKS control plane, the Raft nodes and their EBS volumes all bill
 * whether or not a single query arrives. The serving tier is variable: Fargate
 * bills per pod-second, so it tracks demand. Cost per thousand queries is
 * therefore a hyperbola — dominated by amortising the floor at low QPS,
 * flattening to the marginal serving cost once the floor is spread thin.
 *
 * A managed vector store has a different shape: a smaller floor and a higher
 * marginal rate. Two curves with different slopes cross exactly once, and that
 * crossing is the honest answer to "should you have just used Pinecone?" —
 * below it, no; above it, self-managed wins.
 *
 * ── On the numbers ───────────────────────────────────────────────────────────
 * Every price below is an input, not a fact. They are list prices from memory
 * and will be wrong by the time anyone reads this. Verify against the AWS and
 * vendor pricing pages before quoting any of it; the model is the deliverable,
 * the constants are not.
 *
 *   node tools/cost-model.js --per-pod-qps 40 --warm-floor 1 --csv cost.csv
 */

const fs = require('fs');

const DEFAULTS = {
    // ── fixed: consensus tier ────────────────────────────────────────────────
    eksControlPlaneMonthly: 73.00,   // $0.10/hr
    consensusNodes: 3,
    systemNodes: 1,
    nodeMonthly: 15.20,              // t3.small on-demand, ~$0.0208/hr
    ebsGbMonth: 0.0912,              // gp3
    ebsGbPerNode: 20,
    natGatewayMonthly: 32.40,        // $0.045/hr, single NAT

    // ── variable: serving tier (Fargate) ─────────────────────────────────────
    fargateVcpuHour: 0.04656,
    fargateGbHour: 0.00511,
    podVcpu: 0.5,
    podGb: 1.0,
    perPodQps: 40,                   // sustained QPS one pod handles at target p99
    warmFloor: 1,                    // pods kept running to avoid cold starts

    // ── the managed alternative ──────────────────────────────────────────────
    managedMonthlyFloor: 70.00,      // smallest always-on pod/index
    managedPerMillionQueries: 8.00,  // read units, roughly

    // ── S3, requests, egress ─────────────────────────────────────────────────
    s3StorageGb: 5,
    s3GbMonth: 0.025,
};

function parseArgs() {
    const options = { ...DEFAULTS, csv: null };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in options)) continue;
        options[key] = key === 'csv' ? argv[i + 1] : Number(argv[i + 1]);
    }
    return options;
}

const HOURS_PER_MONTH = 730;

function fixedMonthly(o) {
    return {
        eksControlPlane: o.eksControlPlaneMonthly,
        nodes: (o.consensusNodes + o.systemNodes) * o.nodeMonthly,
        ebs: (o.consensusNodes + o.systemNodes) * o.ebsGbPerNode * o.ebsGbMonth,
        nat: o.natGatewayMonthly,
        s3: o.s3StorageGb * o.s3GbMonth,
    };
}

/**
 * Serving cost at a given QPS.
 *
 * Pods are provisioned for peak, not average, and cannot be fractional — so
 * this rounds up and applies a warm floor. Modelling Fargate as if it billed
 * exactly for work done would flatter the curve and hide the reason the warm
 * floor is a real decision: it is the cold-start mitigation you pay for
 * around the clock.
 */
function servingMonthly(qps, o) {
    const podsForLoad = qps > 0 ? Math.ceil(qps / o.perPodQps) : 0;
    const pods = Math.max(podsForLoad, o.warmFloor);
    const perPodHour = o.podVcpu * o.fargateVcpuHour + o.podGb * o.fargateGbHour;
    return { pods, cost: pods * perPodHour * HOURS_PER_MONTH };
}

function selfManagedPerThousand(qps, o) {
    const fixed = Object.values(fixedMonthly(o)).reduce((a, b) => a + b, 0);
    const serving = servingMonthly(qps, o);
    const monthlyQueries = qps * 3600 * HOURS_PER_MONTH;
    if (monthlyQueries === 0) return { perThousand: Infinity, monthly: fixed + serving.cost, pods: serving.pods };
    return {
        perThousand: ((fixed + serving.cost) / monthlyQueries) * 1000,
        monthly: fixed + serving.cost,
        pods: serving.pods,
        fixed,
        serving: serving.cost,
    };
}

function managedPerThousand(qps, o) {
    const monthlyQueries = qps * 3600 * HOURS_PER_MONTH;
    const monthly = o.managedMonthlyFloor + (monthlyQueries / 1e6) * o.managedPerMillionQueries;
    if (monthlyQueries === 0) return { perThousand: Infinity, monthly };
    return { perThousand: (monthly / monthlyQueries) * 1000, monthly };
}

/** Bisection on the difference. The two curves are monotone, so one crossing. */
function findCrossover(o) {
    const diff = (qps) => selfManagedPerThousand(qps, o).perThousand - managedPerThousand(qps, o).perThousand;
    let low = 0.01;
    let high = 100000;
    if (diff(high) > 0) return null; // self-managed never wins in this range
    for (let i = 0; i < 200; i += 1) {
        const mid = Math.sqrt(low * high);
        if (diff(mid) > 0) low = mid; else high = mid;
    }
    return Math.sqrt(low * high);
}

function sparkline(rows, key, height = 12) {
    const values = rows.map((r) => r[key]).filter((v) => Number.isFinite(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    const lines = [];
    for (let level = height; level >= 1; level -= 1) {
        const threshold = min + ((max - min) * (level - 0.5)) / height;
        let line = '';
        for (const row of rows) {
            const v = row[key];
            line += Number.isFinite(v) && v >= threshold ? '█' : ' ';
        }
        const labelValue = min + ((max - min) * (level - 0.5)) / height;
        lines.push(`${labelValue.toFixed(4).padStart(9)} │${line}`);
    }
    lines.push(`${''.padStart(9)} └${'─'.repeat(rows.length)}`);
    return lines.join('\n');
}

(function main() {
    const o = parseArgs();
    const fixed = fixedMonthly(o);
    const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0);

    console.log('miniRaft cost model — LIST PRICES FROM MEMORY, VERIFY BEFORE QUOTING\n');
    console.log('fixed monthly floor (bills at zero QPS):');
    for (const [name, value] of Object.entries(fixed)) {
        console.log(`  ${name.padEnd(18)} $${value.toFixed(2).padStart(8)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(18)} $${fixedTotal.toFixed(2).padStart(8)}/month`);
    console.log(`\nserving: ${o.podVcpu} vCPU / ${o.podGb} GB per pod, ${o.perPodQps} QPS per pod, ` +
        `warm floor ${o.warmFloor} pod(s)`);

    const qpsPoints = [];
    for (let exponent = -1; exponent <= 3.6; exponent += 0.075) qpsPoints.push(10 ** exponent);

    const rows = qpsPoints.map((qps) => {
        const self = selfManagedPerThousand(qps, o);
        const managed = managedPerThousand(qps, o);
        return {
            qps,
            self: self.perThousand,
            managed: managed.perThousand,
            pods: self.pods,
            selfMonthly: self.monthly,
            managedMonthly: managed.monthly,
        };
    });

    console.log('\n--- cost per 1,000 queries, self-managed (log QPS from 0.1 to ~4000) ---');
    console.log(sparkline(rows, 'self'));
    console.log(`${''.padStart(10)}0.1 QPS ${' '.repeat(Math.max(0, rows.length - 26))} 4000 QPS`);

    console.log('\n  QPS      pods   self $/1k   managed $/1k   self $/mo   managed $/mo   winner');
    const table = [0.1, 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
    for (const qps of table) {
        const self = selfManagedPerThousand(qps, o);
        const managed = managedPerThousand(qps, o);
        const winner = self.perThousand < managed.perThousand ? 'self-managed' : 'managed';
        console.log(
            `${String(qps).padStart(6)}  ${String(self.pods).padStart(6)}   ` +
            `${self.perThousand.toFixed(4).padStart(9)}   ${managed.perThousand.toFixed(4).padStart(12)}   ` +
            `${self.monthly.toFixed(0).padStart(9)}   ${managed.monthly.toFixed(0).padStart(12)}   ${winner}`,
        );
    }

    const crossover = findCrossover(o);
    console.log('\n--- crossover ---');
    if (crossover === null) {
        console.log('  Self-managed never beats the managed store in the modelled range.');
    } else {
        const monthlyQueries = crossover * 3600 * HOURS_PER_MONTH;
        console.log(`  ${crossover.toFixed(1)} QPS  (~${(monthlyQueries / 1e6).toFixed(1)}M queries/month)`);
        console.log(`  Below this, the managed store is cheaper and the honest answer is to use it.`);
        console.log(`  Above it, the fixed floor is amortised and self-managed wins — and keeps winning,`);
        console.log(`  because the marginal cost of a Fargate pod is lower than a per-read charge.`);
    }

    console.log(`
--- what the curve actually says ---
At low QPS the self-managed number is dominated by $${fixedTotal.toFixed(0)}/month of
infrastructure that exists whether or not anyone queries. That is not waste, it
is the price of the properties the consensus tier buys: a control plane that
survives a node failure, leases that make shard ownership unambiguous, and a
rollout that cannot split the fleet across two vector spaces. A managed store
gives none of those and is cheaper precisely because of it.

The warm floor is visible in the curve as the flat left-hand section: with
${o.warmFloor} pod(s) always running, cost per thousand rises without bound as QPS
approaches zero. Setting the floor to zero drops the idle cost to just the
consensus tier and pays for it in cold starts on the first request after a
quiet period — which is exactly the tradeoff tools/coldstart-bench.js prices.

The largest single lever on the floor is the NAT gateway at $${o.natGatewayMonthly.toFixed(0)}/month, which
is why the VPC has an S3 gateway endpoint: shard pulls are the hot path and
routing them through NAT would add both a per-GB charge and a bottleneck during
a mass cold start.`);

    if (o.csv) {
        const header = 'qps,pods,self_per_thousand,managed_per_thousand,self_monthly,managed_monthly\n';
        const body = rows.map((r) =>
            [r.qps.toFixed(4), r.pods, r.self.toFixed(6), r.managed.toFixed(6),
                r.selfMonthly.toFixed(2), r.managedMonthly.toFixed(2)].join(',')).join('\n');
        fs.writeFileSync(o.csv, header + body + '\n');
        console.log(`\nwrote ${rows.length} rows to ${o.csv}`);
    }
})();
