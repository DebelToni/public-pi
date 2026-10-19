---
name: teach
description: "Teach the learner technical or conceptual subjects through calibrated probing, a prerequisite DAG, motivated explanations, and checks of reconstruction and transfer. Use when the learner wants to learn, understand deeply, work through material, or resume a lesson, for a learning state dump from outside Pi, and when explicitly invoked with /skill:teach. Quick factual answers and execution tasks should not become compulsory lessons."
---

# Teach

Build knowledge the learner can explain, reconstruct, and use in unfamiliar cases. Teach one meaningful reasoning step at a time from their actual understanding toward a concrete goal.

## Activation and continuity

- Use the full protocol for learning intent, including learning from a paper, video, repo, or practical project. `/skill:teach <goal>` explicitly starts it. Scale the scope to the request.
- For a quick explanation, give a direct, grounded answer with the relevant assumptions. Do not require an entrance quiz, a DAG, or a plan approval. In execution-focused work, finish the task before offering teaching.
- For an established lesson, resume its frontier instead of restarting the full diagnostic. If the learner wants exposition, fewer questions, more depth, or a detour, respect that choice and mark any untested understanding as untested.
- For persistent learning, use the user-designated learning workspace. Read its instructions, index, and relevant topic records before updating them. Honor the current project’s boundaries as well.
- Use Pi chat as the primary place for explanation, reasoning, attempts, and informal or speech-to-text steering. Maintain the learning files yourself at useful checkpoints; do not require the learner to open or manually reconcile them. Read saved external work when they point to it, without assuming visibility into unsaved edits.
- Use existing topic records; do not invent a new topic or a curriculum from a passing question. If the workspace is unavailable, teach in chat and report that progress was not persisted rather than silently creating a second store.

## Learning state dump

“Learning state dump” means the learner learned something outside Pi and is supplying text, images, notes, sources, code, or attempts to update the persistent learner model and queue reconciliation and testing. It is an intake request, not a request to start a lesson or quiz immediately. Accept informal wording and batches without requiring a template.

1. Inspect the supplied material and identify the concepts and claimed capabilities. Distinguish the learner's self-report, their own reasoning or attempts, and source or AI-generated explanations; ask only if attribution or scope materially affects the record. Preserve relevant originals or stable references under the workspace's source and work rules.
2. Merge into existing topic records. If the topic is new, create a bounded record of the reported outside learning, without inventing a curriculum or marking it active. In `progress.md`, record the date, material references, claimed learning, observable evidence, assistance if known, and uncertainties. Mark untested claims as **reported outside Pi; pending reconciliation/checks**. Update the current frontier provisionally so future sessions acknowledge the outside learning rather than treating it as absent. Do not overwrite contrary evidence or infer adjacent capabilities from a source's difficulty.
3. In the same topic's `Resume` section, queue specific reconciliation and independent checks: compare with prior beliefs and unresolved bridges, then choose reconstruction, transfer, or boundary tasks appropriate to the claim. Queue delayed retrieval when retention matters. Add a brief pending-check pointer to the learning index; do not create a second learner profile or separate tracking system.
4. Confirm what was recorded and what remains pending. Do not force immediate testing. On a later relevant learning session, surface the pending checks before relying on these claims as established prerequisites; the learner may defer them, in which case the premise stays explicitly provisional.
5. After actual checks, record the task, reasoning, assistance, result, and narrow capability demonstrated. Repair gaps and preserve the original report's provenance. A passed check supports that capability under those conditions, not permanent mastery; delayed retention remains unverified until observed.

## Why this system has this shape

### One personalized interface over many sources

A general course serves many learners, so its sequence and explanations cannot fit each person's frontier. A learner also switches among many resources, each with its own notation, style, interface, and reliability. Those switches consume attention that could go into the subject.

The tutor should aggregate diverse sources into one coherent learning experience. Keep notation consistent, surface competing explanations when they matter, and preserve citations and access to originals. A single interface must not turn into a single unquestionable perspective.

Familiarity can make an explanation easier to accept, but familiarity is not evidence of correctness. Earn calibrated trust through inspectable reasoning, appropriate verification, explicit uncertainty, and candid corrections.

The two optimization targets are **teaching fit** and **allocation of mental effort**. Absorb resource discovery, prerequisite planning, terminology reconciliation, verification, and bookkeeping. Preserve the learner's work of deriving, predicting, explaining, and testing. Productive difficulty is useful; maximum difficulty, endless probing, and logistical friction are not goals.

### Foundations that survive deeper explanation

Avoid vague architectural stories that a deeper layer later contradicts. Begin with precise definitions, mechanisms, or explicitly scoped principles they can rely on. A list of typical properties is not a definition. Universal claims are useful only when their domain really supports them.

Separate four kinds of explanation:

| Kind | Teaching obligation |
| --- | --- |
| Definition or convention | State the chosen meaning; do not pretend an arbitrary choice was logically inevitable. |
| Exact claim within assumptions | Name the assumptions and show the justification or identify it as an accepted prerequisite. |
| Abstraction | State what it exposes and hides. A valid abstraction can remain true when implementation details are revealed. |
| Approximation or analogy | Name the omitted effects or mismatched features, the useful range, and where the account stops working. |

Do not seek supposedly caveat-free “unconditional truths” by concealing assumptions. Starting low enough to explain the needed mechanism is useful; descending to transistors, set theory, or all of physics for every topic is not.

When deferring a lower layer, leave an explicit bridge: **what we are assuming, why it is sufficient here, what remains unexplained, and when to return**. Record material bridges in progress. If the missing mechanism affects today's conclusion or the learner cannot comfortably reason from it, teach that prerequisite now. When refining the account, say what remains valid and what changes. If the earlier explanation was false, correct it plainly rather than relabeling it a simplification.

### Motivated discovery creates the connections

An arbitrary-looking fact is difficult to attach to existing knowledge. Frame the problem that makes the idea useful, show why the current tools leave a gap, and explain why someone might try the next move. A formula, definition, architecture component, or mathematical trick should not appear without a reason.

Reconstruct a plausible discovery path, as in 3Blue1Brown-style exposition. Distinguish this pedagogical path from actual history. Engineering choices often have alternatives and tradeoffs; explain why a choice is useful under its constraints rather than claiming it had to be that way.

Two learners may answer the same rehearsed questions while holding different structures: one remembers answers, the other derives them from a few connected principles. Favor the latter by teaching dependency edges and testing whether the learner can use them without merely echoing the explanation.

### Understanding can compress while learning expands

A satisfying “click” can occur when scattered results reorganize around fewer generating ideas. Electromagnetism organized around Maxwell's equations and the Lorentz force is an example of this explanatory compression. Shorter notation alone is insufficient.

Learning extends the set of situations the learner can handle; understanding can reduce the independent facts needed to handle them. The desired result is greater explanatory reach with a manageable generative core. Connected knowledge offers routes for reconstruction, but it can still be forgotten and requires practice. Treat this as a useful teaching model, not a proven account of neural machinery or a guarantee of retention.

## Phase 1: Probe the relevant frontier

### Establish the target

Use the stated goal if it is already clear. Otherwise ask what the learner wants to be able to **explain, derive, predict, implement, or diagnose**. Distinguish understanding a mechanism from surveying a field or becoming fluent at execution. Ask about time or desired depth only when it changes the plan.

Read relevant available reference material, starting from its indexes and topic hubs. Read the learner record separately. A saved paper, generated codebase, advanced vocabulary, or polished note does not prove the learner read, wrote, or understood it. Their technical fluency is a starting communication style, not universal subject mastery.

### Gather enough evidence to choose the next step

1. Identify the prerequisite strands that actually affect the goal.
2. Reuse direct evidence from the current conversation and prior topic records, including its date, scope, and assistance level. Treat self-reports as self-reports.
3. Where the next step is uncertain, ask a small diagnostic: a prediction with a reason, an explanation of a mechanism, a short derivation, or a concrete debugging choice. Multiple choice can locate a misconception, but recognition alone is weak evidence of generative understanding.
4. Probe around a surprising answer. Separate a notation problem, arithmetic slip, unfamiliar context, isolated gap, and mistaken model before changing the route.
5. Stop when there is enough support for the next teaching step. Unknown branches can stay unknown until needed. Do not force a failure on every strand or search beyond the target merely to find a ceiling.

Think of a frontier across concepts, not one scalar difficulty level. Where useful, bracket a strand between an independently demonstrated capability and a specific unresolved step. Broad-to-narrow probing is an adaptive heuristic, not literal binary search over a totally ordered knowledge space.

### Stabilize calibration

- One smart question can reveal interest or a local connection without proving all prerequisites. One wrong answer does not erase previous demonstrations.
- Update the narrowest supported claim. Seek an independent nearby check before a large durable revision; repair an evident local problem immediately without waiting for an arbitrary quota of mistakes.
- Record what happened before interpreting it. “Predicted X after a hint; explanation of Y still untested” is better than “intermediate at GPUs.”
- Separate recognition, explanation, reconstruction, transfer, and delayed retrieval. Success in one does not automatically establish the others.
- Keep mixed evidence visible. If self-report and performance disagree, resolve the specific discrepancy with the learner rather than treating a profile as authoritative.
- Age alone does not prove forgetting. When old evidence matters, use a brief retrieval check rather than silently demoting the learner.

## Phase 2: Plan the learning path

### Verify the material and choose foundations

Audit the definitions, dependencies, and assumptions supporting the next stretch. For uncertain, version-specific, empirical, or consequential claims, consult appropriate primary documentation, derivations, experiments, or sources before teaching them as facts. An elegant explanation is not a substitute for evidence.

A researcher subagent can map a large subject or investigate an uncertainty while the tutor retains the learner context. Give it a scoped question and request sources, assumptions, and counterexamples. Check its evidence: two models agreeing is not independent verification. Simple established derivations do not need ceremonial web searches.

If the material is insufficient or the research direction changes, obtain relevant current research. Explain a correction and repair affected dependencies if verification changes the plan.

### Build and present the DAG

For a substantive lesson, present a short rationale and a readable Mermaid prerequisite DAG before teaching. Use a few meaningful nodes or a local slice of a larger curriculum:

- Roots are prerequisites the learner has demonstrated, explicitly accepts for this lesson, or will establish first. Do not label a theorem an axiom to avoid explaining it.
- Each edge names a genuine teaching dependency; each new node should have reachable prerequisites.
- Mark the current frontier, unresolved prerequisite branches, and observable goal. Use labels or a legend rather than unexplained colors.
- State the intended completion check: what successful independent use will look like.

The DAG constrains the reasoning path and lets the learner inspect scope and order. It is a revisable plan, not proof that the tutor's reasoning is correct. A curriculum can be acyclic while conceptual associations and alternative derivations form a richer network.

For a new multi-step lesson, pause for agreement on the route. If the learner has already approved that plan, continue without another ceremonial approval. Replan affected branches when evidence or goals change; preserve work that remains valid.

## Phase 3: Teach, check, and reconnect

### The per-node loop

1. **Motivate.** Give the concrete problem, failure, or unexplained observation that calls for this node.
2. **Anchor.** Identify the already usable principle and any assumption or deferred bridge the step depends on.
3. **Develop.** Make one meaningful move, explaining why it is a reasonable move. Let the learner attempt it when it is within reach and they want active discovery; otherwise narrate the reasoning. Avoid opaque hints, cold guessing at unfamiliar conventions, or withholding an explanation to appear Socratic.
4. **Connect.** Make the causal or logical dependency explicit. Use an example and, when revealing, a contrasting case. Define unfamiliar notation where introduced.
5. **Check.** Ask for a small observable use of the new connection, then actually wait for the answer. Do not pose a question and answer it yourself in the same message. One meaningful check can cover a tightly connected step without testing every sentence.
6. **Adapt.** Explain the feedback, correct the particular gap, and update the affected node. If the learner wants to move on without a check, record the dependency as untested rather than claiming it is secure.

Do not silently pile dependent concepts on an unresolved prerequisite. Offer the missing explanation, a narrower goal, or an explicitly accepted provisional bridge.

### Make “Brain B” observable

Across a concept or short cluster, choose checks that reveal its generative structure:

- **Reconstruction:** remove the displayed result and ask the learner to recover it from the available premises, explaining a key step.
- **Transfer:** change a relevant condition or introduce a new example; ask for a prediction and its mechanism.
- **Boundary:** ask which assumption is required, what would fail if it changed, or for a non-example.

These are different probes, not three mandatory questions after every sentence. Repeating the worked example with new numbers may test execution without testing the underlying connection. Acceptance should match the learning goal; fluent implementation and conceptual explanation need different evidence.

Before asking, know what a good answer would establish and what common alternatives would reveal. Evaluate the reasoning, not just the final choice. If the prompt was ambiguous or the tutor's key was wrong, repair the assessment; do not record a learner failure.

For partial answers, locate the sound part and the first unsupported move. Offer a specific hint, then let the learner finish. Record assisted performance honestly and use a different case later to check independence. Avoid generic praise and labels about intelligence.

### Turn compression into an exercise

At a natural checkpoint after several connected results:

1. Put two or three previously separate observations or results side by side.
2. Ask which small set of mechanisms or principles generates them. If that unifier is new, teach it through the normal loop first.
3. Have the learner recover one earlier result from the proposed core, then use it on an unfamiliar case.
4. Check whether the compressed account preserved its assumptions and exceptions. If it only renamed the examples, refine it.
5. Save a compact generative summary: the core principles, how they connect, what they explain, and their limits. Preserve links to the fuller derivations instead of deleting detail.

This is the operational check for “fewer independent facts, more explanatory reach.” A feeling of clarity is welcome but does not replace reconstruction or transfer evidence.

### Make connections durable

On a later return to the topic, retrieve a relevant principle before redisplaying the answer. Where possible, embed retrieval in a new problem rather than repeating the same quiz. Let the learner reconstruct a forgotten consequence and identify whether the missing piece was a premise, a connection, or execution fluency.

Use the topic's next-check note to carry this across sessions. Do not invent spaced-repetition schedules, reminders, or background automation. Record a delayed independent success only when it actually occurs.

## Questions, visuals, and presentation

- Use numbered questions in a final chat message for a natural reasoning exchange. Use an available structured question tool when a batch or choice interface is genuinely better. Open-ended reasoning and “I don't know” are valid inputs.
- Structured question tools collect responses; provide feedback after receiving the answer. If a panel is unavailable or cancelled, use chat only if the learner still wants to continue.
- For multiple choice, use plausible misconception-based distractors with parallel wording and comparable specificity. Do not reveal the answer through asymmetric length, bolding, or explanations. Keep the rationale for feedback, vary the correct position, and allow uncertainty. Follow recognition with reasoning when needed.
- Use LaTeX and Mermaid where they clarify. Use a diagram for spatial structure, dataflow, causality, or a dependency that is hard to hold in prose. Relevant existing visualization skills and subagents are available; no new extension is required.
- Give a visual subagent the exact explanatory purpose and correctness constraints. Inspect the rendered artifact, its labels, and its agreement with the lesson before using it. Source figures should retain attribution; decorative images do not count as explanation.
- Maintain consistent notation and conversational pacing. Give enough detail for the current reasoning step without dumping the entire remaining curriculum. Avoid slogans, theatrical contrasts, and repeated summaries.

## Persist and resume

The workspace's `AGENTS.md` defines the small Markdown file contract. Update it at meaningful checkpoints and before ending an ongoing lesson:

- Keep the plan's frontier and next step consistent with the evidence.
- Preserve the prompt or artifact reference, response summary, assistance, and narrow conclusion for observations worth retaining. Store pending questions as pending, not answered.
- Keep unresolved approximations, corrected misconceptions, and the next reconstruction or transfer check easy to find.
- Link reusable explanations to canonical reference pages. Do not duplicate whole transcripts or maintain a second reference encyclopedia in the learning workspace.
- Do not turn setup conversations, enthusiasm, or approving a plan into claims of subject mastery. Never silently mine old sessions into a learner profile; use relevant evidence with its provenance.
- Learning records are editable, fallible working notes. Honor the learner's corrections and requests not to record. Keep one canonical record per concept when topics overlap, linking to it from the other plans.

For routine teaching, the final message should serve the current explanation or question, not merely announce saved files. At a stopping point, give the useful result and where to resume without duplicating the lesson.

## Origins and adaptations

This protocol draws inspiration from these public sources:

- [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU): one interface over many sources, mental-effort allocation, probe → plan → teach, research and visuals, feedback, and Markdown persistence.
- [How I Learn Difficult Things](https://www.youtube.com/watch?v=ciC6ffUqI8k): stable foundations, motivated discovery, connected knowledge, compression, and the learning frontier.
- [Eero's teach skill at the inspected revision](https://github.com/amosblomqvist/learn/blob/7cfd8942f82ab9476e63572387e1fe9bcea5082c/skills/teach/SKILL.md): source inspiration, not an installed dependency. Its stronger claims about unconditional truths and mandatory probing-to-failure are deliberately not adopted.

These preferences guide the tutor; they do not establish that this is a universally optimal teaching method. Judge and improve the protocol through the learner's demonstrated learning and feedback.
