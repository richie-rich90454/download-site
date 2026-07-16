export interface ErrorBoundaryProps {
    message: string;
    onRetry: () => void;
}

export function createErrorBoundary(props: ErrorBoundaryProps): HTMLElement {
    const box = document.createElement("div");
    box.className = "error-boundary";
    box.setAttribute("role", "alert");

    const title = document.createElement("strong");
    title.textContent = "Something went wrong";
    box.appendChild(title);

    const message = document.createElement("p");
    message.textContent = props.message;
    box.appendChild(message);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-primary";
    retry.textContent = "Retry";
    retry.addEventListener("click", function onRetryClick(): void {
        props.onRetry();
    });
    box.appendChild(retry);

    return box;
}
