# Demo Notes (plain-language script — NOT a technical doc)

This file is for *you* to talk from when recording today's demo video. It explains what we
built and why, in plain terms, so you can explain it confidently without reading jargon off a
screen. It intentionally repeats itself a little — treat it like talking points, not a script to
read word for word.

## The 30-second version

"I'm building an AI assistant that lives inside a hospital's medical records system. A doctor
has about 90 seconds between patients — barely enough time to remember who they're seeing and
what's changed. Instead of clicking through five screens, they can just ask the assistant, and
it answers using *only* this patient's real chart data — never guessing, and always showing
exactly which part of the chart backs up what it says."

## Why this project, in human terms

Hospitals use a system called an EHR (Electronic Health Record) to store patient charts —
medications, diagnoses, lab results. The one we're building on top of is called **OpenEMR**,
which is free, open-source, and used by real clinics. We're not building our own medical records
system from scratch — that would take years. We're plugging an AI helper into an existing one,
the same way a real hospital IT team would evaluate a new tool.

## Why the tech stack, explained like you're describing it to a friend, not a recruiter

- **OpenEMR (the medical records system)** — this is the "hospital software." It stores the
  patient data. We didn't change its code; we talk to it the same way any outside app would,
  through its official API (think of an API as a hospital's official front desk — you ask it
  questions in its language, it hands you exactly what you're allowed to see, and it never lets
  you wander into the back room).

- **Cloudflare (where our AI assistant lives)** — Cloudflare runs small pieces of code
  ("Workers") on servers all over the world, so our assistant responds fast no matter where the
  doctor is. It also gives us a small database ("D1") to remember conversations and to log
  everything the assistant does — which matters a lot in healthcare, because if something goes
  wrong, you need to be able to show exactly what happened and why.

  **One thing worth explaining on camera:** OpenEMR itself is an older-style program (it needs a
  specific kind of database Cloudflare doesn't run). So we split it into two pieces: OpenEMR runs
  on a normal server (Railway), and our new AI assistant runs on Cloudflare and talks to OpenEMR
  over the internet, the same way your phone's weather app talks to a weather server. This is
  actually the *safer* way to do it — we're not touching or risking the hospital software itself,
  just building next to it.

- **Claude (the AI model, by Anthropic)** — this is the "brain" that reads the patient's chart
  data and writes the answer in plain English. The important part to say out loud: **we never let
  it just make things up.** Every fact it states has to point to a real piece of the patient's
  chart, or it has to say "I don't know." We check that automatically, every single time, before
  the doctor ever sees the answer.

## The one thing to really emphasize in the video

Say this clearly, because it's the whole point of the project: **"In healthcare, a confident
wrong answer is worse than no answer — it can hurt someone. So the core engineering problem
here isn't 'can I get an AI to talk about a patient,' it's 'how do I make sure it never says
something that isn't actually true, and always shows its work.'"** Then show it live: ask a
question, and point at the little citation/source tags under the answer — that's the proof.

## Also worth mentioning (shows judgment, not just code)

- "We deliberately did **not** let the AI assistant use its own login to read every patient in
  the system. It only ever sees what the logged-in doctor is personally allowed to see — the
  hospital software's own permission system decides that, not us. That matters because in a real
  hospital, a nurse, a resident, and a doctor can all have different access levels."
- "This is Day 1 of a multi-day build. Today's goal was a real, working shell — not a mockup —
  covering one specific, well-defined thing a doctor would actually ask. Tomorrow we add more
  capabilities, more testing, and production-grade login instead of today's simplified version."
- If asked "what's not done yet," be honest: production-grade login (today's is a simplified
  stand-in), a full automated test suite, monitoring dashboards, and load testing under many
  simultaneous users — all planned, all documented, none skipped by accident.

**Say this explicitly on camera — don't skip it:** two of the required pieces are *partially*
done today, and it's worth naming exactly what's there and what isn't, rather than implying
they're finished:

- **"Observability is wired in, but partially."** Every single request gets a unique ID that
  ties together every log line, every tool call, and every AI call for that request, stored in a
  real database — so if something goes wrong, we can trace exactly what happened. What's *not*
  done yet: a visual dashboard and the automated alerts (e.g. "page someone if error rate spikes")
  that the full spec calls for. Today it's real structured logs; tomorrow it's a dashboard on top
  of them.
- **"The eval framework exists, but it's a starting point, not the full suite."** We have five
  automated tests that specifically try to break the safety mechanism — a fabricated fact, a
  patient with no chart data, malformed input — and they all pass. We also manually verified the
  failure modes (no login, OpenEMR down, bad request) against the live deployment. What's *not*
  done yet: testing with two different real user accounts to prove access control (not just
  designed that way), and testing against many concurrent users at once.

Framing it this way — "here's exactly what's real today, here's exactly what's next" — is a
stronger demo than claiming everything's finished. It shows you know the difference.

## Suggested demo flow to record

1. Show the deployed OpenEMR app briefly (it's the "before" — clicking around a normal EHR).
2. Open the Clinical Co-Pilot page, log in.
3. Pick a demo patient, ask: *"What's currently active for this patient?"*
4. Point out the citations under the answer as it comes back.
5. Ask a follow-up question that references the previous answer (shows it remembers context).
6. Ask something the chart genuinely doesn't cover, and show it says so instead of guessing.
7. Close with the 30-second version above, and one sentence on tomorrow's plan.
