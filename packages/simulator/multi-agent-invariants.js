'use strict';

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function unique(values) {
    return [...new Set(values.filter(Boolean))].sort();
}

function fingerprint({ invariant, violationClass, resourceId, agents = [] }) {
    return stable({ invariant, violationClass, resourceId, agents: unique(agents) });
}

function failure(invariant, violationClass, summary, evidence) {
    const exact = fingerprint({
        invariant,
        violationClass,
        resourceId: evidence.resourceId,
        agents: evidence.agents,
    });
    return {
        invariant,
        violationClass,
        summary,
        evidence: stable(evidence),
        fingerprint: exact,
        signature: JSON.stringify(exact),
    };
}

function pass(invariant, summary, evidence = {}) {
    return { invariant, status: 'pass', summary, evidence: stable(evidence) };
}

function fail(check) {
    return { invariant: check.invariant, status: 'fail', summary: check.summary, evidence: check.evidence };
}

function compensationCap(world) {
    const resource = world.resources[world.resourceId];
    const expected = resource.state.orderValueCents;
    const observed = resource.state.compensatedCents;
    if (observed <= expected) {
        return pass('multi-agent.compensation-cap', 'Total customer compensation does not exceed order value.', {
            resourceId: world.resourceId, expected, observed,
        });
    }
    return failure(
        'multi-agent.compensation-cap',
        'OVER_COMPENSATION',
        `Compensation ${observed} exceeds order value ${expected}.`,
        {
            resourceId: world.resourceId,
            expected,
            observed,
            agents: unique(world.appliedCommits
                .filter((commit) => commit.amountCents > 0)
                .map((commit) => commit.agentId)),
        },
    );
}

function exclusiveTerminalState(world) {
    const resource = world.resources[world.resourceId];
    const terminalStates = unique(resource.state.terminalStates || []);
    if (terminalStates.length <= 1) {
        return pass('multi-agent.terminal-exclusive', 'The order has at most one terminal financial state.', {
            resourceId: world.resourceId, terminalStates,
        });
    }
    return failure(
        'multi-agent.terminal-exclusive',
        'MUTUALLY_EXCLUSIVE_TERMINALS',
        `Order entered mutually exclusive terminal states: ${terminalStates.join(', ')}.`,
        {
            resourceId: world.resourceId,
            terminalStates,
            agents: unique(world.appliedCommits
                .filter((commit) => commit.terminalStatus)
                .map((commit) => commit.agentId)),
        },
    );
}

function noStaleWriteAuthorization(world) {
    const stale = world.authorizations.find((authorization) => (
        authorization.accepted
        && authorization.expectedVersion !== authorization.actualVersion
    ));
    if (!stale) {
        return pass('multi-agent.resource-version-fence', 'No effect was authorized from a stale read set.', {
            resourceId: world.resourceId,
        });
    }
    return failure(
        'multi-agent.resource-version-fence',
        'STALE_SHARED_RESOURCE_READ',
        `${stale.agentId} was authorized from ${stale.resourceId}@${stale.expectedVersion} after it reached @${stale.actualVersion}.`,
        {
            resourceId: stale.resourceId,
            expectedVersion: stale.expectedVersion,
            actualVersion: stale.actualVersion,
            decision: 'REVALIDATE',
            agents: [stale.agentId],
        },
    );
}

function singleFinancialOwner(world) {
    const resource = world.resources[world.resourceId];
    const owners = unique(resource.state.financialOwners || []);
    if (owners.length <= 1) {
        return pass('multi-agent.single-financial-owner', 'The business resolution has at most one financial owner.', {
            resourceId: world.resourceId, owners,
        });
    }
    return failure(
        'multi-agent.single-financial-owner',
        'DOUBLE_FINANCIAL_OWNER',
        `Financial resolution has multiple owners: ${owners.join(', ')}.`,
        { resourceId: world.resourceId, owners, agents: owners },
    );
}

function evaluateMultiAgentInvariants(world) {
    // Business harm wins classification over the lower-level stale-read cause.
    // This keeps each mutant's exact predicate stable while preserving the
    // RESOURCE_VERSION_CONFLICT evidence in the trace.
    const evaluated = [
        compensationCap(world),
        exclusiveTerminalState(world),
        noStaleWriteAuthorization(world),
        singleFinancialOwner(world),
    ];
    const first = evaluated.find((check) => check.violationClass) || null;
    return {
        ok: first === null,
        failure: first,
        checks: evaluated.map((check) => (check.violationClass ? fail(check) : check)),
    };
}

function failureFingerprint(result) {
    return result?.failure?.fingerprint || result?.fingerprint || null;
}

function sameMultiAgentFailure(left, right) {
    const leftFingerprint = failureFingerprint(left);
    const rightFingerprint = failureFingerprint(right);
    return leftFingerprint !== null
        && JSON.stringify(stable(leftFingerprint)) === JSON.stringify(stable(rightFingerprint));
}

module.exports = {
    evaluateMultiAgentInvariants,
    failureFingerprint,
    sameMultiAgentFailure,
};
