/**
 * Client-facing error contract.
 *
 * Two rules shape this module. First, a response must never carry an internal message: the
 * previous handler echoed `error.message` verbatim, which leaked absolute filesystem paths
 * through ENOENT and leaked private repository names through the GitHub URL inside an upstream
 * failure message. Second, every failure must tell the person what to do next and must not
 * blame them: "this asset isn't published for that platform", never "you selected an invalid
 * platform".
 *
 * `code` stays stable English so generated clients can branch on it. `message` is prose for a
 * person. `nextStep` is the humanist half: no one should have to guess what to try.
 */

export interface ErrorDefinition {
    status: number;
    message: string;
    nextStep: string;
}

const APP_NOT_FOUND: ErrorDefinition = {
    status: 404,
    message: "There is no app registered under that name.",
    nextStep: "Check the app name, or see the list of available apps at /api/apps."
};

const RELEASE_NOT_FOUND: ErrorDefinition = {
    status: 404,
    message: "That version of this app isn't published here.",
    nextStep: "Use the latest version, or open the download page to see which versions are available."
};

const ASSET_NOT_FOUND: ErrorDefinition = {
    status: 404,
    message: "This release has no file for the platform you're using.",
    nextStep:
        "Open the download page to pick a build for your platform, or pass ?asset= with a file name from the release."
};

const NO_MACOS_ASSET: ErrorDefinition = {
    status: 404,
    message: "This release has no macOS build.",
    nextStep: "Check the release on GitHub, or wait for a version that ships a macOS build."
};

const ROUTE_NOT_FOUND: ErrorDefinition = {
    status: 404,
    message: "That address isn't part of this service.",
    nextStep: "Start from the download page, or see the API reference at /docs."
};

const UPSTREAM_UNAVAILABLE: ErrorDefinition = {
    status: 502,
    message: "We couldn't reach GitHub to complete that request.",
    nextStep: "Wait a moment and try again. If it keeps happening, the mirror may be having trouble syncing."
};

const RATE_LIMITED: ErrorDefinition = {
    status: 429,
    message: "Too many requests from your network just now.",
    nextStep: "Wait a few seconds before retrying. If you are on a shared connection, this can affect others too."
};

const UNSUPPORTED_MEDIA: ErrorDefinition = {
    status: 415,
    message: "That request body isn't a format we can read.",
    nextStep: "Send JSON, and set Content-Type: application/json."
};

const BAD_REQUEST: ErrorDefinition = {
    status: 400,
    message: "Some part of that request didn't look right.",
    nextStep: "Check the parameter names and values, then try again."
};

const INTERNAL: ErrorDefinition = {
    status: 500,
    message: "Something went wrong on our side.",
    nextStep: "Try again shortly. If it persists, quote the request id below when reporting it."
};

/**
 * An error the caller is allowed to know about. Anything not raised as an ApiError is treated
 * as internal and reported as a generic 500, so a new failure mode cannot accidentally become
 * an information leak.
 */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly nextStep: string;

    constructor(code: string, definition: ErrorDefinition) {
        super(definition.message);
        this.name = "ApiError";
        this.code = code;
        this.status = definition.status;
        this.nextStep = definition.nextStep;
    }
}

export const Errors = {
    appNotFound: function (): ApiError {
        return new ApiError("APP_NOT_FOUND", APP_NOT_FOUND);
    },
    releaseNotFound: function (): ApiError {
        return new ApiError("RELEASE_NOT_FOUND", RELEASE_NOT_FOUND);
    },
    assetNotFound: function (): ApiError {
        return new ApiError("ASSET_NOT_FOUND", ASSET_NOT_FOUND);
    },
    noMacosAsset: function (): ApiError {
        return new ApiError("NO_MACOS_ASSET", NO_MACOS_ASSET);
    },
    routeNotFound: function (): ApiError {
        return new ApiError("NOT_FOUND", ROUTE_NOT_FOUND);
    },
    upstreamUnavailable: function (): ApiError {
        return new ApiError("UPSTREAM_UNAVAILABLE", UPSTREAM_UNAVAILABLE);
    },
    rateLimited: function (): ApiError {
        return new ApiError("RATE_LIMITED", RATE_LIMITED);
    },
    unsupportedMedia: function (): ApiError {
        return new ApiError("UNSUPPORTED_MEDIA_TYPE", UNSUPPORTED_MEDIA);
    },
    badRequest: function (): ApiError {
        return new ApiError("BAD_REQUEST", BAD_REQUEST);
    },
    internal: function (): ApiError {
        return new ApiError("INTERNAL_ERROR", INTERNAL);
    }
};

export interface ClientErrorBody {
    error: {
        code: string;
        message: string;
        nextStep: string;
        requestId: string;
    };
}

/**
 * Builds the response body. `requestId` is the only correlation handle a caller gets, and it is
 * what lets someone be helped without a round of "what was your IP address".
 */
export function toClientError(apiError: ApiError, requestId: string): ClientErrorBody {
    return {
        error: {
            code: apiError.code,
            message: apiError.message,
            nextStep: apiError.nextStep,
            requestId: requestId
        }
    };
}

/**
 * Normalises anything thrown into a safe ApiError. Unknown errors collapse to a generic 500 so
 * that an unexpected message, a stack frame, a file path, or an upstream URL can never reach a
 * client through this path.
 */
export function toSafeApiError(thrown: unknown): ApiError {
    if (thrown instanceof ApiError) {
        return thrown;
    }
    return Errors.internal();
}

/**
 * Maps a framework status onto a catalog entry.
 *
 * Used for errors raised by Fastify itself - schema validation, unsupported media type, and so
 * on - which arrive as a 4xx plus a machine code but carry no message safe to show. Reporting
 * the status honestly matters: flattening every client error to 500 hides real problems from
 * monitoring, and flattening a 404 to 400 misleads the caller.
 */
export function fromStatus(status: number): ApiError {
    if (status === 404) {
        return Errors.routeNotFound();
    }
    if (status === 415) {
        return Errors.unsupportedMedia();
    }
    if (status === 429) {
        return Errors.rateLimited();
    }
    if (status >= 400 && status < 500) {
        return Errors.badRequest();
    }
    return Errors.internal();
}
