'use strict';

/**
 * plain-english.js — the layer that makes this lab readable by someone who has
 * never heard of Raft.
 *
 * The engine was correct long before this file existed, and the deck was still
 * useless: every string on screen was written by someone who already knew the
 * answer, for someone who already knew the answer. "Fleet barrier remains
 * closed" is accurate and communicates nothing. A reader cannot tell whether
 * that is good news, bad news, or the bug.
 *
 * So two things live here, deliberately outside the UI:
 *
 *   BRIEFS   — per workload: the failure a normal person would recognise,
 *              stated as a symptom before it is stated as a property.
 *   STEPS    — per event: one sentence explaining what just happened and, when
 *              it is the point of the scenario, why it matters.
 *
 * Keyed by event *label* rather than type, because a workload emits the same
 * type many times ('artifact.checksum.verified' happens three times in the
 * rollout) while labels are unique within a workload. plain-english.test.js
 * enforces both halves of that: labels stay unique, and every label a workload
 * can emit has copy here. Coverage is a test failure, not a silent fallback to
 * jargon — which is exactly how the previous version rotted to one workload out
 * of ten.
 */

/**
 * Each brief answers, in order: what does the user see go wrong, who actually
 * has this problem, what does the obvious implementation do, and what rule
 * prevents it. `symptom` is written from the victim's point of view on purpose
 * — nobody has ever been upset about a linearizability violation as such.
 */
const BRIEFS = {
    configuration: {
        headline: 'A setting change silently never takes effect.',
        symptom: 'You switch a feature off. It stays on for a handful of servers, forever, and nothing anywhere reports an error.',
        whoHitsThis: 'Kubernetes controllers, service meshes, feature-flag systems.',
        naive: 'When the connection drops, reconnect and ask for the current state.',
        rule: 'Resume from the last revision you processed — not from now. "What is true now" cannot tell you what you missed.',
    },
    payment: {
        headline: 'The customer is charged twice for one order.',
        symptom: 'Their card is debited ₹42 twice. The app had shown a failure, so they pressed Pay again — and the automatic retry fired too.',
        whoHitsThis: 'Stripe, Razorpay, and every job queue that promises at-least-once delivery.',
        naive: 'The request timed out, so send it again.',
        rule: 'The charge succeeded and only the reply was lost. Carry a request ID, record the result under it, and replay that result on retry.',
    },
    'vector-search': {
        headline: 'A search quietly returns worse results and reports success.',
        symptom: 'One shard is slow. You get ten results and a 200 OK, and nothing tells you they came from two shards out of three.',
        whoHitsThis: 'Any sharded search — product search, retrieval for RAG, Elasticsearch, Pinecone.',
        naive: 'Wait for every shard, or drop the slow one and return what arrived.',
        rule: 'Answer within the deadline, but disclose the missing shard — and never let the deadline quietly break the tenant filter.',
    },
    rollout: {
        headline: 'One request uses the new model to search an index built by the old one.',
        symptom: 'For thirty seconds during a deploy, search results are subtly nonsense. Every health check is green the whole time.',
        whoHitsThis: 'Any ML serving fleet — ranking, recommendations, semantic search.',
        naive: 'Roll the machines one at a time, like any other deploy.',
        rule: 'Model and index are one indivisible version. Verify everywhere first, then flip a single committed pointer, so no response can ever straddle two versions.',
    },
    streaming: {
        headline: 'Your show jumps backwards because a server you have never heard of restarted.',
        symptom: 'You are sixty-two minutes into a live match. A stale progress report from minute twelve arrives and the player rewinds.',
        whoHitsThis: 'Netflix, Hotstar, Prime Video — anyone with a device limit and a resume position.',
        naive: 'Trust the most recently received update, and count active devices in the leader\'s memory.',
        rule: 'Positions are absolute and may only move forward. A deposed leader\'s decisions are refused by epoch, before capacity is even considered.',
    },
    dispatch: {
        headline: 'Two drivers are sent to the same rider.',
        symptom: 'One driver was in a tunnel. By the time their Accept reaches the server, another driver is already on the way.',
        whoHitsThis: 'Uber, Ola, Swiggy, DoorDash — any offer-and-accept matching system.',
        naive: 'First accept wins, ordered by timestamp.',
        rule: 'Every offer carries a number that only increases. An accept for a superseded number is refused, no matter when it arrives.',
    },
    inventory: {
        headline: 'You sell four units of something you have three of.',
        symptom: 'The order confirms. Two days later the buyer gets the "sorry, actually out of stock" email.',
        whoHitsThis: 'Flash sales and ticketing — Amazon, Flipkart, BookMyShow.',
        naive: 'Read the stock count, check it is above zero, then decrement it.',
        rule: 'Check and decrement are one committed decision. And a leader that cannot commit changes nothing, so a failed order leaves nothing to clean up.',
    },
    feed: {
        headline: 'You post something and your own feed does not show it.',
        symptom: 'You publish, refresh, and it is not there. Refresh again and it appears. Nothing was ever actually lost.',
        whoHitsThis: 'Twitter, Instagram, LinkedIn — anything with a fanned-out timeline behind a cache.',
        naive: 'Write to the store, fan out in the background, and serve reads from the cache.',
        rule: 'Your own reads carry the revision you just wrote, so the timeline may not answer you with anything older. Other readers may lag; you may not.',
    },
    collaboration: {
        headline: 'Two people type at once and the document ends up different on each screen.',
        symptom: 'You see "Hello world", they see "Helloworld". Neither edit was lost and neither person is wrong.',
        whoHitsThis: 'Google Docs, Figma, Notion — offline-capable collaborative editors.',
        naive: 'Apply edits in the order they arrive.',
        rule: 'Make the operations commute. If order cannot change the result, every replica converges without a leader, an election, or a round trip.',
    },
    settlement: {
        headline: 'Money leaves one ledger and never arrives in the other.',
        symptom: 'The coordinator crashed after deciding to commit but before telling either side. One book is short and nobody knows which way it should go.',
        whoHitsThis: 'Cross-bank settlement, payment processors, any transfer spanning two systems with separate owners.',
        naive: 'Ask both sides if they can do it, then tell both sides to do it.',
        rule: 'Write the decision down before announcing it. A replacement coordinator then reads the outcome instead of guessing at it.',
    },
};

/**
 * One sentence per event, keyed by workload id and then by event label.
 *
 * Written to be read in sequence — later lines assume the reader has seen the
 * earlier ones, which is what lets each sentence stay short.
 */
const STEPS = {
    configuration: {
        'Controller lock acquired': 'Only one controller may act at a time. This one holds a lease — a lock that expires on its own, so a crash cannot freeze the system permanently.',
        'CAS establishes desired state': 'The controller writes what the system should look like. Compare-and-set means the write only lands if nobody else changed it first.',
        'Watch starts at revision 6': 'Rather than polling, it subscribes: tell me every change from revision 6 onward.',
        'Desired update appended': 'The change is written into the replicated log. Proposed — not yet official.',
        'Follower persists index 12': 'A second machine writes the same change to its own disk. It now survives one machine dying.',
        '2 of 3 replicas acknowledge': 'A majority holds it durably. Two of three is the smallest group guaranteed to overlap with any future majority, which is why it is enough.',
        'Revision 7 becomes visible': 'With a majority behind it, the change becomes official and readable.',
        'Controller observes revision 7': 'The subscription delivers revision 7 and the controller acts on it.',
        'Watch transport disconnects': 'The network drops the subscription. This is the interesting moment: changes keep happening and nobody is listening.',
        'Revision 8 commits while offline': 'Someone changes the desired state while the controller is deaf to it.',
        'Revision 9 commits while offline': 'And again. Two changes the controller has not seen.',
        'Resume from revision 7': 'On reconnect it does not ask "what is the state now". It asks "what happened after revision 7" — the only question that cannot silently skip a change.',
        'Controller reconciles current intent': 'It replays 8 and 9 and makes reality match. Nothing was missed, and nothing needed a human to notice.',
        'Linearizable read crosses ReadIndex': 'A read that must not be stale. The leader confirms with a majority that it is still the leader, then answers.',
        'Learner promoted one server at a time': 'A new machine joins by catching up silently first, then being promoted. One at a time, so two disjoint majorities can never exist.',
    },

    payment: {
        'Charge request starts': 'Checkout asks to charge ₹42, attaching a stable ID — pay-7 — so any retry can be recognised as the same request.',
        'Gateway accepts pay-7': 'The gateway has capacity and forwards the charge to the replicated payment service.',
        'At-least-once delivery · attempt 1': 'A worker picks up the job. The queue promises to deliver at least once, which is another way of saying it may deliver twice.',
        'Leader appends charge(pay-7)': 'The leader writes the charge into its log. Proposed, not yet safe to act on.',
        'Follower fsyncs index 21': 'A second machine forces the same entry to physical disk. fsync is the difference between "written" and "survives a power cut".',
        'Quorum reaches index 21': 'Two of three machines hold it durably. That majority is what makes it irreversible.',
        'Commit index advances to 21': 'The charge is committed. From here it will happen even if the leader dies this instant.',
        'Ledger effect applies once': '₹42 moves, and the result is stored under pay-7.',
        'Success reply is lost': 'The money moved — and then the reply packet vanished. Checkout has no idea whether it worked. This is the entire problem.',
        'Gateway deadline expires': 'Checkout gives up waiting. From outside, a lost reply and a failed charge look exactly the same.',
        'At-least-once delivery · attempt 2': 'So it retries. A naive processor charges ₹42 a second time right here.',
        'Duplicate is suppressed': 'The processor finds pay-7 in its recorded results and does not touch the ledger.',
        'Original result is replayed': 'It returns the original answer. The retry gets a truthful response and the ledger still shows one charge.',
        'Backpressure rejects excess work': 'Under overload the queue refuses new work rather than accepting it and collapsing. A fast rejection is more useful than a slow timeout.',
        'Poison message is quarantined': 'A message that keeps failing is set aside rather than retried forever, which would starve every healthy job queued behind it.',
    },

    'vector-search': {
        'Query fans out to 3 shards': 'The index is too large for one machine, so the query is asked of all three pieces at once.',
        'Shard 0 traverses with filter': 'It walks only the graph neighbours belonging to tenant acme. Filtering during the walk rather than after it is what stops the result set collapsing to almost nothing.',
        'Shard 0 returns 4 candidates': 'Four nearest matches come back from this piece.',
        'Shard 1 becomes slow': 'One machine stalls. Not dead — slow, which is harder, because there is nothing to detect.',
        'Shard 2 traverses with filter': 'The same filtered walk on the third piece, and it answers in time.',
        'Shard 2 returns 4 candidates': 'Four more candidates. Two of the three shards have now reported.',
        'Shard 1 misses the deadline': 'The router stops waiting. Waiting indefinitely would make every user pay for one sick machine.',
        'Return marked partial results': 'It answers with what it has and says a shard is missing. Silently returning fewer results is indistinguishable from a healthy search — that is the failure worth preventing.',
        'Global top-K merges 2 shards': 'Candidates from the two responding shards are merged and re-ranked into a single top ten.',
        'Late shard result is discarded': 'The slow shard finally replies, after the answer was sent. It is dropped rather than mixed into a result the user already has.',
    },

    rollout: {
        'v2 manifest commits': 'Consensus records which version is coming, where it lives, and its sha256 — before any machine downloads anything. Everyone now agrees what "v2" means.',
        'pod0 downloads v2': 'The first machine pulls 64 MB of model weights.',
        'pod0 verifies checksum': 'The bytes match the committed hash, so they may enter the shadow slot: loaded, warmed, not serving.',
        'pod1 rejects corrupt bytes': 'The second machine received corrupted bytes. Because the correct hash was agreed in advance, this is caught here instead of becoming wrong answers later.',
        'Corruption blocks readiness': 'pod1 refuses to report ready. A machine that cannot verify its model must not be counted as prepared.',
        'pod2 download is slow': 'The third machine is healthy, just slow. Its process is up; only the transfer is degraded.',
        'pod0 shadow is ready': 'pod0 holds v2 loaded and warm while still answering every request with v1.',
        'pod1 retries clean artifact': 'pod1 downloads again and this time gets good bytes.',
        'pod1 verifies retry': 'The hash matches. Only verified bytes are allowed into a shadow slot.',
        'pod1 shadow is ready': 'Two of three now hold verified v2, all three still serving v1.',
        'Canary evaluation passes': 'A slice of traffic on v2 shows an error rate 0.02% above v1 — inside the 0.10% budget agreed beforehand, so this is not a judgement call.',
        'Fleet barrier remains closed': 'Two ready, three required, so nothing switches. This is the rule that prevents the failure: no machine flips until every machine could.',
        'Slow pod2 finishes download': 'The straggler completes. The active version has not moved at any point during the wait.',
        'pod2 verifies checksum': 'All three machines now hold identical, verified bytes.',
        'pod2 shadow is ready': 'Three of three prepared. Every machine could serve v2 this instant, and none of them is.',
        'Fleet barrier opens': 'Now — and only now — is switching safe, because no machine can be caught holding the wrong pair.',
        'model/current=v2 appended': 'The switch is one entry in the replicated log, not three machines each deciding for themselves.',
        'Activation reaches quorum': 'A majority records the switch, making it the single official version.',
        'Atomic pointer flips to v2': 'Every request now takes its embedding model and its index from the same version slot. That pairing is precisely what stops a new-model query hitting an old-model index.',
        'Post-flip regression triggers rollback': 'Live metrics get worse after the flip. Time to go back.',
        'Atomic rollback restores v1': 'One more committed entry moves everyone back. v1 was never deleted — still verified, still warm — so the rollback is instant rather than another download.',
    },

    streaming: {
        'TV starts the live match': 'One device on a two-device plan. The session is recorded in consensus, not in one server\'s memory.',
        'Playback reaches 00:30': 'The player reports where it is. An absolute position, not "advance thirty seconds" — the difference matters shortly.',
        'Phone joins as the second device': 'Both slots on the plan are now taken, and that count lives in the log rather than one server\'s head.',
        'Third device is refused': 'A laptop asks and is told no. The refusal is itself committed, so a failover cannot forget that it happened.',
        'Uplink congestion hits the phone': 'The phone\'s connection degrades. Nothing about who is entitled to watch has changed.',
        'Phone rebuffers once': 'Quality drops. Annoying, but not a correctness failure — nobody is charged and no state is wrong.',
        'Entitlement leader is isolated': 'The server tracking who is watching is cut off from the others. It does not know that yet.',
        'node1 wins term 2': 'The rest elect a new leader. Two servers now briefly believe they are in charge.',
        'Stale leader cannot admit a third stream': 'The old leader tries to admit the laptop and is refused — not on capacity, but because its epoch is out of date. Its authority expired without it ever noticing.',
        'Late heartbeat would rewind playback': 'A position stamped 00:12 arrives after 00:30 was recorded. Applying it would visibly jump the viewer backwards, so it is discarded.',
        'Playback resumes at 01:02': 'Playback continues forward through the failover. The viewer never noticed that a leader changed.',
        'TV stops watching': 'The TV session is released and a slot frees up. The release is committed like everything else, so the count stays true.',
        'Laptop is admitted now': 'The same laptop that was refused is admitted, because a slot genuinely opened rather than because anyone lost track.',
        'Old leader rejoins as a follower': 'The isolated server reconnects, discovers a newer leader, and gives up its claim — having done no damage while it was wrong.',
    },

    dispatch: {
        'Rider requests a car': 'A ride request enters the system and needs exactly one driver, chosen once.',
        'Surge multiplier 1.4× quoted': 'A price is quoted and pinned to this request so it cannot move underneath the rider.',
        'Offer 1 goes to driver-a': 'The ride is offered to the nearest driver with an epoch number attached. That number only ever increases.',
        'driver-a loses signal in a tunnel': 'Their phone goes dark. Their app still shows the offer.',
        'Offer 1 expires unanswered': 'No answer in time, so the offer expires. The rider is still waiting.',
        'Offer 2 goes to driver-b': 'Reassigned to another driver at epoch 2. The number went up, which is the only thing that makes the old offer identifiable as old.',
        'driver-b accepts at epoch 2': 'Accepted at the current epoch. The ride is theirs.',
        'driver-a accepts too late': 'driver-a emerges from the tunnel and their accept finally lands, carrying epoch 1. Refused. Without that number, two drivers are now converging on one rider.',
        'A second rider is offered driver-b': 'A different rider is matched to driver-b, who is already carrying someone.',
        'Double booking is refused': 'driver-b already holds a ride. One driver, one ride.',
        'ride-12 is re-offered to driver-c': 'The second rider is matched to a free driver instead.',
        'driver-c takes ride-12': 'Accepted at the current epoch, so this one stands. The second rider has a car.',
        'ride-9 completes': 'The first ride finishes and driver-b becomes available again.',
    },

    inventory: {
        'Sale opens with 3 units': 'Three units, five buyers. The count lives in consensus rather than in a cache.',
        'order-1 reserves 1 unit': 'Checking stock and taking a unit are one committed decision. Split into two steps, two buyers read "one left" simultaneously and both proceed.',
        'order-2 reserves 1 unit': 'A second buyer takes a unit. One left, and three buyers still trying.',
        'Leader is cut off mid-sale': 'The server holding the count loses contact with the majority.',
        'order-3 reaches the wrong leader': 'A buyer\'s order arrives at that isolated server. It writes the reservation locally and waits for a majority that can never answer.',
        'order-3 times out with no reservation': 'The buyer sees a failure — and critically, no stock moved. There is nothing to undo and no apology email to send.',
        'node1 takes over in term 6': 'The majority elects a new leader holding the true count.',
        'order-3 retries and succeeds': 'The buyer retries against the real leader and takes the last unit. Sold out.',
        'order-4 is refused — sold out': 'The next buyer is refused immediately. That refusal is recorded, so a later leader cannot quietly disagree with it.',
        'order-2 payment is declined': 'A card is declined after the unit was already held, so the hold has to be given back.',
        'order-2 releases its unit': 'The hold returns to stock exactly once. Releasing twice would create inventory that does not exist.',
        'order-5 takes the returned unit': 'A waiting buyer takes the returned unit rather than it being lost to the count.',
        'order-3 retries once more': 'A duplicate retry arrives and receives the existing hold instead of consuming a second unit.',
        'order-1 is confirmed': 'The first order is finalised and its hold becomes a real sale.',
        'node0 rejoins and truncates': 'The isolated server reconnects and deletes the reservation it wrote but never committed. Its version of reality loses, which is exactly right.',
    },

    feed: {
        'Home timeline is warm but behind': 'A cache serves your feed quickly. Quickly, and slightly out of date.',
        'post-41 commits': 'Your post is durably stored. It exists, and no failure from here can lose it.',
        'Fan-out is queued': 'Copying it into followers\' timelines happens in the background — that is how feeds stay fast at scale.',
        'Fan-out delivery is delayed': 'The background job is slow, so followers\' timelines do not have it yet.',
        'Author reloads immediately': 'You refresh at once. Your read carries the revision you just wrote, so the timeline may not answer with anything older. You see your own post.',
        'Another reader may still see the old feed': 'Someone else refreshes and does not see it yet. That is acceptable — they never observed it existing. Only your own writes must be visible to you.',
        'Fan-out reaches the timeline': 'The background copy lands and everyone sees it.',
        'Worker redelivers the item': 'The job runs twice. The timeline stores by post ID, so a duplicate delivery is not a duplicate post.',
        'Later reload is served at the edge': 'Back to the fast cache, now correct — the guarantee cost one slow read, not a slow product.',
    },

    collaboration: {
        'All replicas start at RAFT': 'Three copies of one document. No leader and no election — nobody is in charge here, which is the point.',
        'alice goes offline': 'She keeps editing on a plane, with no way to ask anyone what the document looks like.',
        'bob goes offline': 'So does he, separately, with no knowledge that Alice is editing at all.',
        'alice appends !': 'The edit is recorded as an operation with an ID and a parent, not as "the document is now X".',
        'alice appends a second !': 'A second operation, whose parent is the first.',
        'bob concurrently appends ?': 'Bob edits at the same time with no knowledge of Alice. Neither of them is wrong.',
        'relay receives bob first': 'The relay happens to hear Bob\'s edit before Alice\'s.',
        'alice:2 arrives before its parent': 'Alice\'s second edit arrives before her first. It is held rather than applied — applying it now would build on something that is not there.',
        'Parent arrives and unlocks the child': 'Her first edit lands and the buffered one is released behind it.',
        'alice receives bob:1': 'Alice gets Bob\'s edit, in a different order than the relay did.',
        'bob also receives the child first': 'Bob hits the same out-of-order arrival and buffers it too.',
        'bob receives alice:1': 'The parent arrives and both operations apply. Bob has now seen the same three edits in a third distinct order.',
        'alice reconnects': 'Back online, and now the three replicas have to agree without anyone arbitrating.',
        'bob reconnects': 'Back online too. Every edit has now reached every replica, in three different orders.',
        'alice:1 is delivered twice': 'A duplicate arrives and is ignored by ID. All three replicas now show an identical document despite three different arrival orders — that is what converging means, and why no leader was needed.',
    },

    settlement: {
        'Begin transfer-88 for ₹42': 'Move ₹42 between two separately owned ledgers. Neither can see or trust the other\'s internal state.',
        'Debit ledger votes YES': 'It sets the money aside and promises it can commit. After this it may not change its mind.',
        'Credit ledger votes YES': 'The same promise on the other side. Both ledgers are now committed to an outcome neither of them gets to choose.',
        'COMMIT decision becomes durable': 'The coordinator writes COMMIT down before telling anybody. That ordering is the entire trick.',
        'Coordinator dies before sending COMMIT': 'It crashes at the worst possible instant: decided, nobody informed.',
        'Participants are blocked in PREPARED': 'Both sides are stuck holding money they have promised and cannot release. This is the real cost of two-phase commit, and it is worth showing rather than hiding.',
        'Replacement reads the durable decision': 'A new coordinator starts and reads the recorded outcome. It does not have to guess, because the decision was written before it was announced.',
        'Debit ledger applies COMMIT': '₹42 leaves the debit ledger, minutes after the coordinator that decided it had already died.',
        'Credit ledger applies COMMIT': '₹42 arrives. Both sides reached the same outcome despite the crash.',
        'COMMIT delivery is retried': 'A retried message, applied by transaction ID, so the money does not move a second time.',
        'Begin transfer-89 for ₹80': 'A second transfer, to show the other ending — the one where the answer is no.',
        'Debit ledger votes NO': 'Insufficient funds. One NO is enough to decide the whole transaction.',
        'ABORT becomes durable': 'ABORT is written down first, exactly as COMMIT was.',
        'ledger-a applies ABORT': 'The reservation is released and the held money goes back.',
        'ledger-b applies ABORT': 'And on the other side. Nothing moved anywhere.',
    },
};

/** The brief for a workload, or null if one has not been written yet. */
function briefFor(workloadId) {
    return BRIEFS[workloadId] || null;
}

/**
 * Plain copy for one event. Returns null rather than a vague filler string:
 * a caller that silently substitutes "the system advances one step" is how the
 * previous version ended up with nine unexplained workloads and no test failure.
 */
function stepCopy(workloadId, label) {
    const workload = STEPS[workloadId];
    return (workload && workload[label]) || null;
}

module.exports = { BRIEFS, STEPS, briefFor, stepCopy };
