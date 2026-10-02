import { fail, failure } from "@/lib/http";
import { addResume, listResumes } from "@/lib/resume";
import { parseUserId, resumeProblem } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ userId: string }> };

/** Resumes the user has uploaded, newest first. */
export async function GET(_request: Request, { params }: Ctx) {
  const userId = parseUserId((await params).userId);
  if (!userId) return fail("Not a valid user id.", 400);
  try {
    return Response.json({ resumes: await listResumes(userId) });
  } catch (err) {
    return failure(err);
  }
}

/** Upload a resume PDF; answers once the agent has added the candidate. */
export async function POST(request: Request, { params }: Ctx) {
  const userId = parseUserId((await params).userId);
  if (!userId) return fail("Not a valid user id.", 400);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail("Choose a PDF to upload.", 400);
  const problem = resumeProblem(file);
  if (problem) return fail(problem, 400);
  try {
    return Response.json({ resume: await addResume(userId, file) });
  } catch (err) {
    return failure(err);
  }
}
