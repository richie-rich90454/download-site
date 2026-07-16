export function createLoadingSkeleton(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "skeleton-stack";
    wrapper.setAttribute("aria-busy", "true");
    wrapper.setAttribute("aria-live", "polite");

    const row1 = document.createElement("div");
    row1.className = "skeleton skeleton-row";
    wrapper.appendChild(row1);

    const row2 = document.createElement("div");
    row2.className = "skeleton skeleton-row skeleton-row--short";
    wrapper.appendChild(row2);

    const actions = document.createElement("div");
    actions.className = "skeleton-actions";
    for (let i = 0; i < 3; i = i + 1) {
        const pill = document.createElement("div");
        pill.className = "skeleton skeleton-pill";
        actions.appendChild(pill);
    }
    wrapper.appendChild(actions);

    return wrapper;
}
