import { describe, test, expect } from "vitest";
import { formatFileSize, formatDate, formatRelativeDate } from "../../src/public/format-utils.js";

describe("format-utils", function () {
    describe("formatFileSize", function () {
        test("formats bytes", function () {
            expect(formatFileSize(512)).toBe("512 B");
        });

        test("formats kilobytes", function () {
            expect(formatFileSize(1536)).toBe("1.5 KB");
        });

        test("formats megabytes", function () {
            expect(formatFileSize(1572864)).toBe("1.5 MB");
        });

        test("formats gigabytes", function () {
            expect(formatFileSize(1610612736)).toBe("1.5 GB");
        });
    });

    describe("formatDate", function () {
        test("formats valid date", function () {
            const result = formatDate("2024-01-15T00:00:00Z");
            expect(result.indexOf("2024") >= 0).toBe(true);
            expect(result.indexOf("15") >= 0).toBe(true);
        });

        test("returns input for invalid date", function () {
            expect(formatDate("not-a-date")).toBe("not-a-date");
        });
    });

    describe("formatRelativeDate", function () {
        test("formats just now", function () {
            const now = new Date().toISOString();
            expect(formatRelativeDate(now)).toBe("just now");
        });

        test("formats minutes", function () {
            const date = new Date(Date.now() - 120000).toISOString();
            expect(formatRelativeDate(date)).toBe("2 minutes ago");
        });

        test("formats one minute singular", function () {
            const date = new Date(Date.now() - 60000).toISOString();
            expect(formatRelativeDate(date)).toBe("1 minute ago");
        });

        test("formats one hour singular", function () {
            const date = new Date(Date.now() - 3600000).toISOString();
            expect(formatRelativeDate(date)).toBe("1 hour ago");
        });

        test("formats hours", function () {
            const date = new Date(Date.now() - 7200000).toISOString();
            expect(formatRelativeDate(date)).toBe("2 hours ago");
        });

        test("formats one day singular", function () {
            const date = new Date(Date.now() - 86400000).toISOString();
            expect(formatRelativeDate(date)).toBe("1 day ago");
        });

        test("formats days", function () {
            const date = new Date(Date.now() - 172800000).toISOString();
            expect(formatRelativeDate(date)).toBe("2 days ago");
        });

        test("formats one month singular", function () {
            const date = new Date(Date.now() - 2592000000).toISOString();
            expect(formatRelativeDate(date)).toBe("1 month ago");
        });

        test("formats months", function () {
            const date = new Date(Date.now() - 5184000000).toISOString();
            expect(formatRelativeDate(date)).toBe("2 months ago");
        });

        test("formats one year singular", function () {
            const date = new Date(Date.now() - 31536000000).toISOString();
            expect(formatRelativeDate(date)).toBe("1 year ago");
        });

        test("formats years", function () {
            const date = new Date(Date.now() - 63072000000).toISOString();
            expect(formatRelativeDate(date)).toBe("2 years ago");
        });
    });
});
