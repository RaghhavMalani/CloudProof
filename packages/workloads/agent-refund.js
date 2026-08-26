'use strict';

const {
    AgentExecution,
    RESUME_DECISION,
    decideResume,
    makeSemanticSnapshot,
} = require('../agent-runtime/index.js');

const EXECUTION_ID = 'support-ticket-4821';
const REFUND = Object.freeze({ orderId: 4821, amountCents: 899900, currency: 'INR' });
const BASE_CONTEXT = Object.freeze({
    workflow: 'refund-agent-v7',
    model: 'model-2026-08-20',
    prompt: 'sha256:a892',
    policy: 'refund-policy-v4',
    retrievalIndex: 'support-index-v81',
    toolSchemas: { payments: 'v2', orders: 'v14', crm: 'v6', mail: 'v3' },
});

function check(id, status, summary, evidence = {}) {
    return { id, status, summary, evidence };
}

function makeNode(id, role, progress, accent = 'blue', process = 'up', network = 'connected') {
    return { id, label: id, process, network, raftRole: role, detail: progress, accent };
}

function createState() {
    const pinnedSnapshot = makeSemanticSnapshot(BASE_CONTEXT);
    return {
        execution: new AgentExecution({
            executionId: EXECUTION_ID,
            workflow: BASE_CONTEXT.workflow,
            snapshot: pinnedSnapshot,
        }),
        pinnedSnapshot,
        availableSnapshot: pinnedSnapshot,
        checkpoint: null,
        paymentProvider: new Map(),
        paymentCalls: 0,
        remoteRefundEffects: 0,
        reconciliations: 0,
        duplicateEffectsSuppressed: 0,
        semanticConflicts: [],
        snapshotTransitions: [],
        crashes: 0,
        resumes: 0,
        crm: new Map(),
        emails: new Map(),
        authorizedSnapshots: new Set(),
        effectSnapshots: [],
        completed: false,
    };
}

function current(state) {
    if (!state.execution) throw new Error('agent worker is not running');
    return state.execution;
}

function commitLocalEffect(state, logicalAction, parameters, result) {
    const execution = current(state);
    const intent = execution.ledger.recordIntent({
        executionId: execution.executionId,
        logicalAction,
        parameters,
        snapshotId: execution.snapshot.id,
        atStep: execution.step,
    });
    if (intent.duplicate) {
        state.duplicateEffectsSuppressed += 1;
        return { ...intent.record, duplicate: true };
    }
    execution.ledger.markDispatched(intent.record.effectId);
    execution.ledger.recordResult(intent.record.effectId, result);
    const committed = execution.ledger.commit(intent.record.effectId);
    state.effectSnapshots.push({ logicalAction, snapshotId: committed.snapshotId });
    return { ...committed, duplicate: false };
}

function applyCommittedEntry(state, entry) {
    const execution = state.execution;
    switch (entry.op) {
        case 'observe-context':
            execution.advance('semantic-context-pinned', { orderId: REFUND.orderId });
            return { snapshotId: execution.snapshot.id };
        case 'authorize':
            execution.advance('policy-authorized', { authorized: true, amountCents: REFUND.amountCents });
            state.authorizedSnapshots.add(execution.snapshot.id);
            return { policy: execution.snapshot.resources.policy, snapshotId: execution.snapshot.id };
        case 'record-refund-intent': {
            const intent = execution.ledger.recordIntent({
                executionId: execution.executionId,
                logicalAction: 'refund-payment',
                parameters: REFUND,
                snapshotId: execution.snapshot.id,
                atStep: execution.step,
            });
            state.refundEffectId = intent.record.effectId;
            execution.advance('refund-intent-recorded', { refundEffectId: state.refundEffectId });
            return { effectId: state.refundEffectId, duplicate: intent.duplicate };
        }
        case 'dispatch-refund':
            execution.ledger.markDispatched(state.refundEffectId);
            state.paymentCalls += 1;
            if (!state.paymentProvider.has(state.refundEffectId)) {
                state.paymentProvider.set(state.refundEffectId, {
                    providerRefundId: 'rf_4821_01',
                    orderId: REFUND.orderId,
                    amountCents: REFUND.amountCents,
                });
                state.remoteRefundEffects += 1;
            }
            return { providerCommitted: true, responseDelivered: false };
        case 'lose-refund-response':
            execution.ledger.requireReconciliation(state.refundEffectId);
            return { effectId: state.refundEffectId, status: 'RECONCILIATION_REQUIRED' };
        case 'checkpoint-crash':
            state.checkpoint = execution.checkpoint();
            state.execution = null;
            state.crashes += 1;
            return { step: state.checkpoint.step, durableEffects: state.checkpoint.effects.length };
        case 'deploy-policy':
            state.availableSnapshot = makeSemanticSnapshot({ ...BASE_CONTEXT, policy: entry.policy });
            return { from: state.pinnedSnapshot.resources.policy, to: entry.policy };
        case 'resume':
            state.execution = AgentExecution.resume(state.checkpoint);
            state.resumes += 1;
            return { step: state.execution.step, effectStatus: state.execution.ledger.get(state.refundEffectId).status };
        case 'check-semantic-snapshot': {
            const verdict = decideResume({
                pinned: current(state).snapshot,
                available: state.availableSnapshot,
                compatibility: { policy: RESUME_DECISION.REQUIRE_APPROVAL },
            });
            if (verdict.decision !== RESUME_DECISION.CONTINUE) {
                state.semanticConflicts.push(verdict);
                current(state).status = 'WAITING_FOR_REVALIDATION';
            }
            return verdict;
        }
        case 'revalidate': {
            const prior = current(state).snapshot;
            current(state).snapshot = state.availableSnapshot;
            current(state).status = 'RUNNING';
            current(state).advance('human-approved-revalidation', { policy: state.availableSnapshot.resources.policy });
            state.authorizedSnapshots.add(state.availableSnapshot.id);
            state.snapshotTransitions.push({ from: prior.id, to: state.availableSnapshot.id, approved: true });
            return { from: prior.resources.policy, to: state.availableSnapshot.resources.policy };
        }
        case 'reconcile-refund': {
            const resolution = current(state).ledger.resolve(state.refundEffectId);
            if (resolution.action !== 'reconcile') return { action: resolution.action, duplicate: true };
            const providerResult = state.paymentProvider.get(state.refundEffectId);
            if (!providerResult) throw new Error('provider has no matching refund to reconcile');
            current(state).ledger.recordResult(state.refundEffectId, providerResult);
            const committed = current(state).ledger.commit(state.refundEffectId);
            state.reconciliations += 1;
            state.effectSnapshots.push({ logicalAction: committed.logicalAction, snapshotId: committed.snapshotId });
            current(state).advance('refund-reconciled', { providerRefundId: providerResult.providerRefundId });
            return { action: 'provider-lookup', providerRefundId: providerResult.providerRefundId };
        }
        case 'concurrent-retry': {
            const intent = current(state).ledger.recordIntent({
                executionId: EXECUTION_ID,
                logicalAction: 'refund-payment',
                parameters: REFUND,
                snapshotId: current(state).snapshot.id,
                atStep: current(state).step,
            });
            const resolution = current(state).ledger.resolve(intent.record.effectId);
            if (intent.duplicate) state.duplicateEffectsSuppressed += 1;
            return { duplicate: intent.duplicate, action: resolution.action, paymentCalls: state.paymentCalls };
        }
        case 'update-crm': {
            const result = commitLocalEffect(state, 'mark-order-refunded', { orderId: REFUND.orderId }, { status: 'refunded' });
            state.crm.set(REFUND.orderId, 'refunded');
            current(state).advance('crm-updated', { crmStatus: 'refunded' });
            return { effectId: result.effectId, status: 'refunded' };
        }
        case 'checkpoint-crash-late':
            state.checkpoint = current(state).checkpoint();
            state.execution = null;
            state.crashes += 1;
            return { step: state.checkpoint.step, crm: state.crm.get(REFUND.orderId) };
        case 'resume-late':
            state.execution = AgentExecution.resume(state.checkpoint);
            state.resumes += 1;
            return { step: state.execution.step, next: 'notify-customer' };
        case 'notify': {
            const result = commitLocalEffect(state, 'send-refund-email', { orderId: REFUND.orderId, template: 'refund-confirmed-v3' }, { messageId: 'msg_4821_01' });
            state.emails.set(REFUND.orderId, result.result.messageId);
            current(state).advance('customer-notified', { messageId: result.result.messageId });
            return { messageId: result.result.messageId };
        }
        case 'complete':
            current(state).advance('workflow-completed');
            current(state).status = 'COMPLETED';
            state.completed = true;
            return { step: current(state).step, status: current(state).status };
        default:
            return { ok: true };
    }
}

const agentRefund = {
    id: 'agent-refund',
    name: 'Autonomous refund agent',
    shortName: 'Agent refund',
    question: 'Can an agent survive lost responses, crashes, policy drift, and a concurrent retry without refunding twice?',
    scenario: '₹8,999 refund · lost response · policy deploy · two crashes · concurrent worker',
    createState,
    applyCommittedEntry,
    actions: [
        { atMs: 0, key: 'start', type: 'agent.transaction.started', lane: 'clients', actor: 'refund-agent', target: 'runtime', label: 'Agent transaction begins', detail: 'The runtime pins the model, prompt, refund policy, retrieval index, and every tool schema before reasoning starts.', correlationId: EXECUTION_ID, entry: { op: 'observe-context' }, data: (_s, { effect }) => effect },
        { atMs: 18, key: 'authorize', type: 'agent.policy.authorized', lane: 'commits', actor: 'refund-agent', target: 'policy-v4', label: '₹8,999 refund is authorized', detail: 'The authorization and its semantic snapshot are durable evidence, not a transient line in an LLM transcript.', correlationId: EXECUTION_ID, entry: { op: 'authorize' }, data: (_s, { effect }) => effect },
        { atMs: 31, key: 'intent', type: 'agent.effect.intent.recorded', lane: 'commits', actor: 'runtime', target: 'effect-ledger', label: 'Refund intent commits before I/O', detail: 'A stable effect ID binds this ticket, logical refund action, and exact parameters before the payment API is called.', correlationId: EXECUTION_ID, entry: { op: 'record-refund-intent' }, data: (_s, { effect }) => effect },
        { atMs: 46, key: 'remote-commit', type: 'tool.payment.refund.committed', lane: 'commits', actor: 'payment-api-v2', target: 'order-4821', label: 'Payment provider commits refund', detail: 'The money has moved remotely. The local runtime has not received the response yet.', correlationId: EXECUTION_ID, causedBy: 'intent', entry: { op: 'dispatch-refund' }, data: (_s, { effect }) => effect },
        { atMs: 47, key: 'lost', type: 'fault.tool.response.lost', lane: 'faults', actor: 'network', target: 'refund-agent', label: 'Provider response is lost', detail: 'The runtime records ambiguity instead of guessing whether it is safe to retry.', correlationId: EXECUTION_ID, causedBy: 'remote-commit', entry: { op: 'lose-refund-response' }, data: (_s, { effect }) => effect },
        { atMs: 52, key: 'crash-1', type: 'fault.worker.crashed', lane: 'faults', actor: 'worker-1', target: 'runtime', label: 'Worker crashes after remote commit', detail: 'The last durable checkpoint includes the refund intent and its reconciliation-required state.', correlationId: EXECUTION_ID, causedBy: 'lost', entry: { op: 'checkpoint-crash' }, process: 'down', data: (_s, { effect }) => effect },
        { atMs: 300, key: 'policy-v5', type: 'semantic.resource.deployed', lane: 'faults', actor: 'policy-control', target: 'refund-agent', label: 'Refund policy v5 is deployed', detail: 'The paused workflow reasoned under v4. Blindly resuming it under v5 would mix incompatible semantic worlds.', correlationId: EXECUTION_ID, entry: { op: 'deploy-policy', policy: 'refund-policy-v5' }, data: (_s, { effect }) => effect },
        { atMs: 410, key: 'resume-1', type: 'agent.execution.resumed', lane: 'commits', actor: 'worker-2', target: 'runtime', label: 'Worker resumes at the durable step', detail: 'It restores the recorded effect instead of restarting from the customer message.', correlationId: EXECUTION_ID, causedBy: 'crash-1', entry: { op: 'resume' }, process: 'up', data: (_s, { effect }) => effect },
        { atMs: 414, key: 'snapshot-conflict', type: 'semantic.snapshot.conflict', lane: 'invariants', actor: 'runtime', target: 'policy-v5', label: 'Semantic snapshot conflict detected', detail: 'The runtime refuses to continue old reasoning under a new policy and moves the workflow to revalidation.', correlationId: EXECUTION_ID, causedBy: 'policy-v5', entry: { op: 'check-semantic-snapshot' }, data: (_s, { effect }) => effect },
        { atMs: 520, key: 'revalidate', type: 'human.revalidation.approved', lane: 'commits', actor: 'support-lead', target: 'runtime', label: 'Human approves revalidation under v5', detail: 'The semantic boundary advances explicitly; earlier work remains attributable to its v4 authorization.', correlationId: EXECUTION_ID, causedBy: 'snapshot-conflict', entry: { op: 'revalidate' }, data: (_s, { effect }) => effect },
        { atMs: 548, key: 'reconcile', type: 'agent.effect.reconciled', lane: 'commits', actor: 'runtime', target: 'payment-api-v2', label: 'Runtime reconciles instead of retrying', detail: 'A provider lookup finds the existing refund and commits its result locally without a second mutation.', correlationId: EXECUTION_ID, causedBy: 'lost', entry: { op: 'reconcile-refund' }, data: (_s, { effect }) => effect },
        { atMs: 552, key: 'race', type: 'agent.effect.duplicate.suppressed', lane: 'invariants', actor: 'worker-3', target: 'effect-ledger', label: 'Concurrent worker is fenced', detail: 'A racing worker derives the same effect ID and receives the recorded result.', correlationId: EXECUTION_ID, causedBy: 'reconcile', entry: { op: 'concurrent-retry' }, data: (_s, { effect }) => effect },
        { atMs: 590, key: 'crm', type: 'tool.crm.updated', lane: 'commits', actor: 'crm-v6', target: 'order-4821', label: 'CRM records the committed refund', detail: 'Downstream state changes only after the payment effect is known to be committed.', correlationId: EXECUTION_ID, causedBy: 'reconcile', entry: { op: 'update-crm' }, data: (_s, { effect }) => effect },
        { atMs: 602, key: 'crash-2', type: 'fault.worker.crashed', lane: 'faults', actor: 'worker-2', target: 'runtime', label: 'Worker crashes again at step 6', detail: 'The CRM effect and workflow cursor are durable, so neither payment nor CRM work needs to repeat.', correlationId: EXECUTION_ID, causedBy: 'crm', entry: { op: 'checkpoint-crash-late' }, process: 'down', data: (_s, { effect }) => effect },
        { atMs: 720, key: 'resume-2', type: 'agent.execution.resumed', lane: 'commits', actor: 'worker-4', target: 'runtime', label: 'Workflow resumes at notification', detail: 'Recovery restores the exact cursor, semantic snapshot, history, and effect ledger.', correlationId: EXECUTION_ID, causedBy: 'crash-2', entry: { op: 'resume-late' }, process: 'up', data: (_s, { effect }) => effect },
        { atMs: 744, key: 'email', type: 'tool.email.sent', lane: 'commits', actor: 'mail-v3', target: 'customer-4821', label: 'Customer receives one confirmation', detail: 'Notification follows the committed refund and CRM update and has its own stable effect identity.', correlationId: EXECUTION_ID, causedBy: 'resume-2', entry: { op: 'notify' }, data: (_s, { effect }) => effect },
        { atMs: 760, type: 'agent.transaction.completed', lane: 'commits', actor: 'runtime', target: EXECUTION_ID, label: 'Agent transaction completes', detail: 'Two crashes, one policy deployment, one lost response, and one racing worker produced exactly one refund.', correlationId: EXECUTION_ID, causedBy: 'email', entry: { op: 'complete' }, data: (_s, { effect }) => effect },
    ],
    invariants(state) {
        const authorized = state.effectSnapshots.every((effect) => state.authorizedSnapshots.has(effect.snapshotId));
        return [
            state.remoteRefundEffects === 1
                ? check('refund-effect-at-most-once', 'pass', 'one provider refund despite a lost reply and a concurrent retry', { observed: state.remoteRefundEffects, paymentCalls: state.paymentCalls })
                : check('refund-effect-at-most-once', 'fail', 'the provider observed more than one refund', { observed: state.remoteRefundEffects }),
            state.semanticConflicts.length === 1 && state.snapshotTransitions.every((item) => item.approved)
                ? check('semantic-snapshot-isolation', 'pass', 'policy drift stopped execution until explicit revalidation', { transitions: state.snapshotTransitions })
                : check('semantic-snapshot-isolation', 'fail', 'execution crossed a semantic boundary without revalidation'),
            authorized
                ? check('effect-requires-authorization', 'pass', 'every committed tool effect belongs to an authorized semantic snapshot', { effects: state.effectSnapshots })
                : check('effect-requires-authorization', 'fail', 'a tool effect has no matching policy authorization'),
            state.crm.get(REFUND.orderId) === 'refunded' && state.emails.has(REFUND.orderId) && state.completed
                ? check('causal-side-effect-order', 'pass', 'payment committed before CRM and notification', { crm: state.crm.get(REFUND.orderId), email: state.emails.get(REFUND.orderId) })
                : check('causal-side-effect-order', 'fail', 'downstream state does not match the refund outcome'),
            state.resumes === 2 && current(state).step === 8
                ? check('durable-resumption', 'pass', 'two crashes resumed from checkpoints and completed step 8', { crashes: state.crashes, resumes: state.resumes })
                : check('durable-resumption', 'fail', 'the workflow cursor was lost or replayed incorrectly'),
        ];
    },
    metrics(state) {
        return [
            { label: 'refunds', value: state.remoteRefundEffects, unit: `${state.paymentCalls} API call` },
            { label: 'recovered', value: state.resumes, unit: `${state.crashes} crashes` },
            { label: 'effects fenced', value: state.duplicateEffectsSuppressed, unit: 'duplicate' },
            { label: 'semantic conflicts', value: state.semanticConflicts.length, unit: 'revalidated' },
            { label: 'workflow step', value: current(state).step, unit: current(state).status.toLowerCase() },
        ];
    },
    explainEvent(event) {
        const explanations = {
            'fault.tool.response.lost': 'A timeout cannot reveal whether the provider failed before mutation or succeeded before its reply was lost. The durable intent turns that uncertainty into an explicit reconciliation state.',
            'semantic.snapshot.conflict': 'The checkpoint contains reasoning produced under refund-policy-v4. Comparing its pinned snapshot with the available v5 environment prevents semantic read skew.',
            'agent.effect.reconciled': 'The provider is queried with the stable effect identity. Its existing refund is imported into the ledger as the original intent result; the mutation is not sent again.',
            'agent.effect.duplicate.suppressed': 'Both workers derive the same identity from ticket, logical action, and parameters. The committed ledger entry fences the second worker.',
            'agent.execution.resumed': 'The checkpoint restores the workflow cursor, semantic snapshot, state, history, and effect ledger—not just chat history.',
        };
        return explanations[event.type] || event.data.detail;
    },
    visualization(state) {
        const execution = state.execution;
        const policy = execution ? execution.snapshot.resources.policy : state.checkpoint.snapshot.resources.policy;
        const refundCommitted = state.remoteRefundEffects === 1 && state.reconciliations === 1;
        return {
            title: `ticket 4821 · step ${execution ? execution.step : state.checkpoint?.step || 0}`,
            subtitle: `₹8,999 · ${state.crashes} crashes · ${state.semanticConflicts.length} semantic conflict · ${state.remoteRefundEffects} refund`,
            nodes: [
                makeNode('agent-runtime', execution ? 'workflow runner' : 'recovering', execution ? execution.status.toLowerCase() : 'checkpoint durable', execution ? 'green' : 'amber', execution ? 'up' : 'down'),
                makeNode('effect-ledger', 'durable fence', refundCommitted ? 'refund committed' : state.refundEffectId ? 'intent recorded' : 'empty', refundCommitted ? 'green' : 'amber'),
                makeNode('payment-api', 'tool · v2', state.remoteRefundEffects ? 'rf_4821_01' : 'no refund', state.remoteRefundEffects ? 'green' : 'blue'),
                makeNode('policy', policy, state.semanticConflicts.length ? 'revalidated' : 'snapshot pinned', state.semanticConflicts.length ? 'amber' : 'blue'),
                makeNode('crm', 'tool · v6', state.crm.get(REFUND.orderId) || 'pending', state.crm.has(REFUND.orderId) ? 'green' : 'blue'),
                makeNode('customer', 'human', state.emails.has(REFUND.orderId) ? 'notified once' : 'waiting', state.emails.has(REFUND.orderId) ? 'green' : 'blue'),
            ],
            policy: 'No tool mutation without a durable intent; no retry of an ambiguous effect; no resume across semantic drift without revalidation.',
        };
    },
};

module.exports = agentRefund;
