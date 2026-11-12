# Interactive illustration

How to draw a figure in SVG that answers the pointer: a server rack whose units slide out, a keyboard whose keys sink, a diagram whose nodes rise. Motion timing and easing still come from [motion.md](motion.md); this file covers the drawing and the plumbing under it.

## When to read this

Read it when the deliverable is a drawn object or scene that reacts to the pointer: a hero figure, an empty-state illustration, an explanatory diagram. Do not read it for ordinary UI motion such as hover states, menus, modals or page transitions. Those are [motion.md](motion.md) alone.

## Frame

- Draw into one fixed `viewBox`, for example `0 0 400 320`, and never resize it. Every coordinate, pointer position included, is in viewBox units.
- The host element reserves its shape before anything draws: `aspect-ratio` on the box, width from the container. On the server, or before the script runs, the box is empty but already the right size, so nothing shifts when the figure appears.
- The figure scales with the container's width and never sets its own height. It must fit a box of the given ratio at any width without scrolling or clipping.
- Check the figure at the smallest width it will be shown, often a card a few hundred pixels across. If its outline no longer says what the object is there, cut parts rather than shrinking them: too many small pieces turn into noise first.

## Projection

- Every point goes through one projection function, `P(x, y, z) → [sx, sy]`, with z up. Nothing is placed in screen space by hand.
- Default to the 2:1 view used in pixel-art isometry (elevation whose sine is 0.5): every figure on a page then shares one camera. Change it only when the viewing angle is what the figure is about, and never mix views in one figure.
- Keep the inverse too: from a screen point back to the world on a plane at a given height. Hit areas need it.
- Fit the frame to the most extreme pose, not the rest pose: include the fully extended, lifted or opened positions when you centre and scale. Otherwise the far end of the interaction leaves the frame.

## Paint order

SVG has no depth buffer, so the order of the nodes is the depth.

- Faces that should hide what is behind them are opaque and filled with the ground colour. A transparent face shows edges it should hide.
- Append from the far corner to the near one. With the ground axes x and y both increasing toward the viewer, sort by ascending x + y, then by height. A part with a long footprint can be both in front of and behind its neighbours; split it into unit-sized pieces before sorting.
- Guides and dashed lines go before the plate they belong to, so the plate covers them.
- If a moving part changes which neighbour it sits in front of, reorder that one node in the DOM. Rebuilding every node each frame costs time and drops whatever state the nodes held.

## Line hierarchy

The look comes from restraint in the strokes, not from colour.

- A solid is its silhouette plus one dim inner line where the top meets the sides. Vertical corner edges are not drawn; round the corners of the top and base instead.
- Silhouettes use the edge colour, inner lines a dimmer one. Inner lines as bright as silhouettes flatten the drawing.
- One bright accent at a time, and it means one thing: what the pointer chose, or, at rest, where the eye should start. Once the pointer picks something, the accent moves there and the rest position goes back to the plain edge colour.
- No glows, gradients, shadows or extra fills to signal state. Moving one stroke from the edge colour to the bright one is the whole signal.
- No words inside the drawing. Names and values go to a caption outside it, so the figure must make sense without them.
- Rest is a composition, not a flat grid: give parts uneven rest values so the still frame works as a thumbnail.
- Stroke width stays constant in CSS pixels at any size: `vector-effect: non-scaling-stroke`.
- Colours are CSS custom properties with a dark-mode set, so the figure follows the page.

## Hit areas

Decide what the pointer is over from where things **rest or are heading**, never from where they are on screen right now.

Why: if a part moves away from the pointer when chosen, testing against its current position un-chooses it, it moves back, it is chosen again, and the figure flickers in a loop.

- For a field of parts on the ground, project the pointer onto the ground plane (z = 0), which never moves, and pick by world position.
- For parts at different heights, one ground plane picks the wrong part behind a raised one. Give each part a hit shape computed once from its resting geometry, and choose among those.
- When a choice depends on an animated value, read its target, not its current value.
- Use the pointer events of the host element only; do not measure the DOM (`elementFromPoint`, `:hover`) to pick.

## One loop

- Every figure on the page shares one `requestAnimationFrame` loop. Each figure registers a tick that returns whether it is still moving.
- The loop stops when every tick reports rest, and restarts on input. A figure off screen does no work: watch it with an `IntersectionObserver`.
- Continuous input (where the pointer is) drives springs, because the target moves every frame. A discrete change (which part is chosen) drives a tween with a long ease-out. Pick the constants once for the figure.
- Staggered parts start in order of distance from the pointer, 30–60 ms apart, so the motion spreads from where the hand is.
- Every movement has a maximum, and every falloff a minimum, so the figure still holds together at the strongest setting.
- Tear-down removes every listener, observer and node the figure added; a figure mounted twice (React StrictMode) must not leave a second loop running.

## Reduced motion

The CSS override in `motion.md` does not reach script-driven motion, so the loop reads `matchMedia('(prefers-reduced-motion: reduce)')`, listens for changes, and while it matches lands every spring and tween on its target in one frame.

A pointer-driven figure is a case where the motion is the content. Follow the "When motion is the content" rule in [motion.md](motion.md#reduced-motion-contract): jump straight to the target state or show the choice with a highlight, keep answering the pointer, and never leave the figure blank or frozen mid-pose.

## Sources

- Hairline by Lucas Marques (github.com/lucasmarkes/hairline, MIT): the ideas behind this file — rest-pose hit areas, the shared sleeping loop, silhouette-plus-crease solids and the stroke-only accent. The text here is agemon's own.
