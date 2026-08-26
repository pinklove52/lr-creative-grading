# PhotoDNA and creative operators

This reference defines the creative contract. The implementation remains deterministic and photo-specific; inspiration-library entries may inform a candidate only when the user asks, and never replace PhotoDNA.

## Analyze the visible baseline

Analyze the current Lightroom proxy or supplied image exactly as seen. photo_dna.source_digest identifies those rendered bytes and therefore equals target.proxy_digest, while target.source_digest remains the stable photo/file identity. Do not automatically remove an existing cast, flatten contrast, recover every highlight, open every shadow, suppress grain, or reset an edited JPEG.

PhotoDNA combines:

- semantics and visual anchors;
- luminance distribution and local contrast;
- a chroma-weighted 360-bin hue histogram;
- an OKLCH palette and cold-warm axis;
- texture and material cues;
- person regions and protection constraints supplied by model/context judgment plus deterministic image evidence.

Normalize semantic evidence into creative_intent before candidate construction. Persist subject_priority, protected_colors, temperature, tone, contrast, saturation, texture directions, break_operator, and intent_digest. Persist an operator_graph per candidate that names the shared intent, offline nodes, and Lightroom nodes. Semantic evidence must alter the graph or recipe when it changes the authored direction; do not use it only as rationale prose.

The orchestrating model must pass JSON semantic hints for subject, scene, mood, lighting, and materials through analyze --semantic-hints. It passes model/context person judgment separately through --protected-people or --people-boxes so the analyzer writes it into photo_dna.protected_people before candidates are compiled. OpenCV or any other face detector may contribute boxes, but it is never the sole authority: profiles, occlusion, small figures, bodies without visible faces, and contextual evidence still require protection.

Smooth the circular hue histogram, protect near-neutrals from unstable hue assignment, and evaluate every anchor from 0 through 359 degrees against these nine harmony families:

1. monochromatic;
2. analogous;
3. analogous-complementary;
4. complementary;
5. split-complementary;
6. dyad;
7. triad;
8. tetrad;
9. square.

Record the winning family, anchor, score, competing families, and the colors that would move. Deterministic ranking uses score first, then lower weighted hue displacement, then the fixed rule order above, then the lower anchor number.

## Build three independent routes

### Native

Organize and extend relationships already visible in PhotoDNA. Native may retain an unusual cast, crushed region, high-key exposure, grain, or muted palette when it is part of the image's identity. It should improve hierarchy and coherence without replacing the visual language.

Typical operators include gentle hue attraction toward the detected harmony, selective chroma cleanup, anchor-preserving tone shaping, and texture emphasis tied to the subject.

### Amplify

Strengthen the most distinctive existing axis: cold versus warm, hard versus soft, luminous versus low-key, saturated accent versus compressed field, or fine texture versus haze. Amplify must identify which PhotoDNA relationship it is enlarging.

Typical operators include stronger selective chroma, steeper or split channel curves, wider color-temperature separation, controlled black or highlight compression, and more assertive texture.

### Break

Reconstruct the image according to its structure rather than conventional correctness. Choose an operator graph that differs from Amplify, such as:

- duotone or tritone remapping;
- palette compression around a non-obvious harmony;
- cross-processing through separate channel curves;
- low-key shadow swallowing with a protected visual anchor;
- posterized or stepped tonal zones;
- selective channel offset;
- solarized edge or false-color accents;
- extreme grain or chroma-noise texture.

Break may deliberately create a cast, clipped channel, dead black, hard highlight, saturation spike, or discontinuity. Each such choice requires an intentional_artifact record with purpose, scope, expected signature, and person-protection impact.

## Strength from 0 through 200 percent

Zero percent is the pinned current technical baseline. One hundred percent is the route's authored design. Values above 100 extrapolate the same route rather than switching routes.

Compile every scalar Lightroom parameter as a spec containing operation, value, and interpolation. operation is delta or target; interpolation is linear or circular_degrees. Bare floats are invalid except under an explicit legacy_numeric_mode delta compatibility declaration.

Interpolate:

- delta controls as baseline plus strength factor times value;
- target controls from baseline toward value;
- hue through the shortest circular arc;
- target curve_points by corresponding control points;
- discrete operators through an explicit threshold recorded in offline_ops.

The compiler must compare extrapolated values with bridge capabilities. If a value leaves a reported range, redesign the recipe or classify it as unexpected. Never silently clamp it.

Each candidate has its own default design_strength. A normal set might place Native below 100, Amplify near or above 100, and Break higher, but the image determines the actual values.

## Separate preview and Lightroom semantics

offline_ops record the operations actually rendered by NumPy, OpenCV, and Pillow. lr_recipe records the nearest supported Lightroom intent. Keep both even when they differ.

lr_recipe.preview_fidelity must explicitly record directional_not_pixel_equivalent for the bundled offline renderer. A candidate may add a more detailed high, medium, or concept note, but never claim pixel-level equivalence with Adobe rendering.

## Protect people

Every person image requires credible skin gradients, facial depth, and skin texture across Native, Amplify, and Break. Protection is not a request for neutral or beauty-retouched skin.

Compile protection in this order:

1. prevent destructive global mapping of detected face and skin ranges where possible;
2. preserve luminance separation across forehead, cheeks, nose, lips, and jaw;
3. preserve texture by limiting global clarity, denoise, posterization, and grain spill in person regions;
4. if global settings remain insufficient, request one inverse person-mask compensation after the global transaction.

Break may radically reconstruct the environment while the person stays perceptually credible. A stylized skin hue is acceptable only when gradients, depth, and texture remain believable and the artifact is explicit.

## Keep collection manual

The collect command may store PhotoDNA, final recipe, preview, and Lightroom readback only when the user explicitly says to save or collect the look. Do not auto-learn, auto-scrape network images, or infer consent from finishing a grade.
