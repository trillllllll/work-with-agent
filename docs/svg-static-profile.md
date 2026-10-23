# Static SVG profile

`server/src/shared/svg-policy.ts` owns the rules used by both the browser and server. The adapters only parse XML; the browser also runs DOMPurify and checks that normalization after filtering exactly matches the shared output. A filtering change is an explicit failure, never a successful graphic with missing content.

## Supported

- Basic shapes, groups, text/tspan, title/desc and text-only metadata.
- Common text, paint, stroke and visibility presentation attributes; language and accessibility descriptions; harmless class/data annotations.
- Finite SVG lengths including decimals, exponents, relative/physical units and supported keywords. Property-specific bounds apply.
- Linear/radial gradients, local gradient inheritance and clipPath, with correctly typed local references. Standard quoted or whitespace-separated local `url()` forms are normalized.
- Plain text and CDATA retain their characters. URL words, comparison signs and backslashes in descriptions are text, not resource references.
- A leading XML declaration is accepted. DTDs, entity declarations, other processing instructions and foreign element namespaces are rejected.
- Restricted inline presentation styles: last declaration wins and overrides the corresponding attribute. Supported geometry/font CSS lengths require valid CSS units; `transform` and `d` in style are explicitly unsupported because their CSS grammar differs from SVG attributes. SVG `transform` and `d` attributes remain supported.

## Intentionally unsupported

Scripts, events, external resources, images, foreignObject, animation, style sheets, arbitrary CSS/variables, filters, masks, patterns, use/symbol and textPath. Unknown visual attributes/elements fail explicitly rather than disappearing. Non-text content in title/desc/metadata is unsupported.

Marker definitions support ordinary arrows, but resource contents may not explicitly or implicitly reference another marker. Effective inherited marker values are included in this check; an explicit reset to `none` is respected. This prevents tiny inputs from expanding into millions of nested shapes.

## Budgets

The shared `svgLimits` object defines source/output bytes, node/depth limits, length/viewBox bounds, resource count/dependency depth, path-number and transform counts, and an estimated expanded geometry/text cost for every repeated marker and clipping resource application. Units are validated before serialization. Relative lengths use conservative estimates and remain subject to the image/canvas viewport limits; this is a bounded static profile, not a complete SVG/CSS implementation.

## Verification

`e2e/fixtures/svg-policy-cases.json` is the shared normal/rejected matrix. Server tests preserve text and assert normalization is idempotent; browser tests compare the same canonical outputs to Node and decode every accepted image. Real chat tests cover both historical Markdown and standalone blocks, reload, source view, enlargement and SVG/PNG downloads. `static-svg-showcase.svg` and the original `weekly-work-distribution.svg` provide visual fixtures.
