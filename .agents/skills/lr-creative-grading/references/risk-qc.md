# Creative risk and quality control

Quality control protects authorship and execution integrity, not conventional taste. An unusual image is not a failed image merely because it is dark, saturated, grainy, color-biased, clipped, or unsuitable for a competition.

## Risk classes

| Class | Meaning | Effect |
| --- | --- | --- |
| intentional | A visible artifact is a designed part of the selected route | Allow when fully declared and verified |
| warning | A plausible side effect needs monitoring or disclosure | Apply, inspect, and report |
| unexpected | An unintended artifact, protection failure, protocol failure, or target mismatch | Mark blocked; prevent selection/application or roll back |

Only unexpected risk blocks selection, application, or completion. A diagnostic preview may still render and display the blocked label unless the renderer itself cannot produce a valid, safely bounded derivative.

## Intentional artifact record

Every deliberate cast, clip, dead black, saturation spike, posterized zone, channel discontinuity, extreme grain, or other aggressive effect uses kind intentional, code intentional_artifact, a concise message, and an artifact object with four non-empty strings:

- purpose;
- scope;
- expected_signature;
- people_impact.

The message or artifact object should also state the acceptable boundary and how final verification will distinguish the design from a failure.

An unlabeled extreme side effect is not automatically intentional.

## Unexpected blockers

Treat these as unexpected:

- target photo or baseline digest mismatch;
- unknown, unsupported, or out-of-range parameter;
- partial application or readback mismatch;
- accidental banding, halo, posterization, or channel break outside the declared scope;
- mask spill, edge seams, or missed person regions;
- implausible skin gradients, collapsed facial depth, or destroyed skin texture;
- a changed crop, healing operation, mask, or lens correction outside recipe scope;
- proxy/preview labels mapped to the wrong candidate;
- bridge disconnect or failed rollback.

## Preflight

Before application:

1. validate GradeSession and target digests;
2. confirm exactly three distinct candidates and one explicit selection;
3. compare the selected recipe with runtime parameter capabilities;
4. verify that every aggressive operation has a risk record;
5. compile person protection;
6. confirm snapshot and rollback readiness;
7. ensure export, batch sync, overwrite, collection, and metadata changes remain disabled.

## Preview QC

Render every candidate from the same baseline, crop, dimensions, and resampling. Check:

- histogram and channel clipping against declared intent;
- skin and face continuity;
- important neutral behavior when neutrals matter to the design;
- subject priority and visual anchors;
- gradients, halos, banding, noise, and texture;
- label, recipe hash, and cache-key correctness.

Offline previews show intent, not proof of Adobe pixel equivalence.

If preview QC finds an unexpected risk, keep the candidate available as a clearly blocked diagnostic preview when safe. Do not allow select or apply until the unexpected risk is resolved and the recipe hash is regenerated.

## Final QC

Default to no more than two visual checks:

1. fit view for hierarchy, palette, global tone, subject separation, and declared extreme artifacts;
2. useful zoom only when checking people, masks, texture, grain, banding, or halos.

Also compare desired, applied, and readback values. Record warnings without neutralizing them. Correct or roll back every unexpected result.

For people, verify credible hue transitions, forehead/cheek/nose/jaw luminance depth, lips and eye-area separation, texture, and clean mask boundaries. This protection remains mandatory even when the environment is aggressively reconstructed.

## Optional external constraints

Competition rules, documentary fidelity, submission color spaces, export dimensions, and authenticity limits apply only when the user explicitly requests them. Add them as named constraints; never treat them as the default grading standard.
