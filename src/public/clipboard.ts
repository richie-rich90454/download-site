export async function copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_err) {
            // Intentionally fall through to the fallback implementation.
        }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    let success: boolean;
    try {
        success = document.execCommand("copy");
    } catch (_err) {
        success = false;
    }
    document.body.removeChild(textarea);
    return success;
}
