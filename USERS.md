# Target User & Use Cases

## The user

**A primary care physician with a 15–20 patient day in an outpatient clinic**, seeing patients
back-to-back in 15–20 minute slots. Between rooms they have roughly 90 seconds — barely enough
to glance at a chart, let alone reconstruct a patient's full history, current meds, and what
changed since the last visit. They are already logged into OpenEMR as themselves (not a shared
kiosk account), and they only ever need to see patients on their own panel.

This is deliberately narrower than "a physician" or "clinic staff in general." A resident on
overnight intake or a hospitalist rounding on twelve admissions has different urgency, different
data needs (e.g. overnight vitals trends vs. outpatient med reconciliation), and a different
tolerance for latency. Those are future personas, not this one.

## Concrete workflow

30 seconds before opening the app: the physician has just finished with the previous patient,
is walking to the next room, and has the next patient's name/MRN from the schedule but nothing
else loaded in their head.

They open the Co-Pilot, it already knows which patient (launched in the context of that
patient's chart), and they ask a question in plain language instead of clicking through tabs:
"What's changed since her last visit?" / "Is she on anything that would interact with
ibuprofen?" / "Remind me why he's on metformin."

## Use cases this agent addresses (Stage 1 shell)

### UC-1: "What's currently active for this patient?"
The physician asks for a fast summary of active problems, current medications, and the most
recent relevant observations/labs — the three things they'd otherwise flip between tabs to
assemble by hand.
**Why an agent, not a dashboard:** the physician doesn't know in advance which of the three
categories matters most for this visit — a static dashboard shows all of it whether relevant or
not, and doesn't answer a specific follow-up ("wait, when was that started?") without more
clicking. A conversational agent lets them start broad and drill down in the same breath they'd
use with a colleague.

### UC-2: Follow-up questions in the same context (multi-turn)
After the initial summary, the physician asks a follow-up — "how long has she been on that?" —
without re-stating the patient or re-explaining what "that" refers to.
**Why an agent:** this is inherently a conversation, not a lookup. A dashboard has no notion of
"that" from the previous answer; a chat agent that holds conversational state does.

### UC-3: Refusing to answer what isn't in the chart
If the physician asks something the fetched chart data doesn't cover (e.g. a lab that wasn't
ordered, or a historical detail outside the fetched window), the agent must say so explicitly
rather than filling the gap with general medical knowledge stated as if it were this patient's
fact.
**Why an agent (and not, say, a smarter search box):** the failure mode here isn't "no results" —
it's a fluent, confident-sounding wrong answer. An agent with an explicit verification step can
distinguish "I don't have that" from "the chart says X," which a keyword search can't reason
about at all.

## Deferred to later stages (explicitly out of scope for today's shell)

- Nurse / resident / supervising-physician role distinctions beyond "OpenEMR's own login
  decides what this user can see" (see ARCHITECTURE.md's authorization section).
- Proactive "here's what changed for everyone on today's schedule" batch view (Stage-4-style use
  case from the spec's own example) — today's shell is reactive/on-demand only.
- Drug-interaction / dosage-threshold enforcement as a hard clinical rule engine — today's
  verification layer checks *source attribution* (did the model make this up?), not clinical
  correctness against a rules database. That's a named limitation, not silently skipped.
