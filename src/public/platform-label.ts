export function getPlatformLabel(filename: string): string {
    const name = filename.toLowerCase();
    let label = "Other";
    if (name.indexOf("windows") >= 0 || name.endsWith(".exe") || name.endsWith(".msi")) {
        label = "Windows";
    } else if (name.indexOf("mac") >= 0 || name.indexOf("osx") >= 0 || name.endsWith(".dmg") || name.endsWith(".pkg")) {
        label = "macOS";
    } else if (
        name.indexOf("linux") >= 0 ||
        name.endsWith(".appimage") ||
        name.endsWith(".deb") ||
        name.endsWith(".rpm")
    ) {
        label = "Linux";
    }
    if (
        name.indexOf("x64") >= 0 ||
        name.indexOf("amd64") >= 0 ||
        name.indexOf("intel") >= 0 ||
        name.indexOf("x86_64") >= 0
    ) {
        label = label + " (x64)";
    } else if (name.indexOf("arm64") >= 0 || name.indexOf("aarch64") >= 0 || name.indexOf("apple silicon") >= 0) {
        label = label + " (ARM64)";
    } else if (name.indexOf("x86") >= 0 || name.indexOf("i386") >= 0) {
        label = label + " (x86)";
    }
    return label;
}
