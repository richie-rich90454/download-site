import { describe, test, expect, vi } from "vitest";
import { createErrorBoundary } from "../../src/public/components/error-boundary.js";

describe("error-boundary", function () {
    test("calls onRetry when retry button is clicked", function () {
        const onRetry = vi.fn();
        const boundary = createErrorBoundary({ message: "Failed", onRetry: onRetry });
        const button = boundary.querySelector("button");
        expect(button).not.toBe(null);
        if (button !== null) {
            button.click();
            expect(onRetry).toHaveBeenCalledTimes(1);
        }
    });
});
