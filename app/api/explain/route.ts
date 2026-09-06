import { explainInContext, AIServiceError } from "../../../lib/ai";
import { explainRequestSchema } from "../../../lib/validation";

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      ...jsonHeaders,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    }
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON.", code: "INVALID_JSON" },
      { status: 400, headers: jsonHeaders }
    );
  }

  const input = explainRequestSchema.safeParse(body);
  if (!input.success) {
    console.warn("[Reader AI API] Invalid explain request payload:", input.error.flatten());
    return Response.json(
      {
        error: "The explain request is invalid.",
        code: "VALIDATION_FAILED",
        details: input.error.flatten()
      },
      { status: 400, headers: jsonHeaders }
    );
  }

  try {
    const explanation = await explainInContext(input.data);
    return Response.json(explanation, { status: 200, headers: jsonHeaders });
  } catch (error) {
    console.error("[Reader AI API] Explanation request failed:", error);

    if (error instanceof AIServiceError) {
      return Response.json(
        {
          error: error.message,
          code: error.code
        },
        { status: error.status, headers: jsonHeaders }
      );
    }

    const message = error instanceof Error ? error.message : "Internal AI processing error.";
    return Response.json(
      {
        error: `Unable to explain this selection right now. (${message})`,
        code: "INTERNAL_ERROR"
      },
      { status: 500, headers: jsonHeaders }
    );
  }
}
