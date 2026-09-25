/**
 * A module-level render tally for the hook scenarios. A probe calls `countRender()` in its body, so
 * the counter rises once per executed render: the number a scenario wants next to its timing is how
 * many components React actually re-rendered, which is exactly what the store layer under
 * measurement decides. Scenarios reset it in `beforeEach` and report it as a counter from `run`.
 */
let renders = 0;

function countRender(): void {
    renders += 1;
}

function resetRenderCount(): void {
    renders = 0;
}

function getRenderCount(): number {
    return renders;
}

export {countRender, getRenderCount, resetRenderCount};
