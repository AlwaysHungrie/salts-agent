import { authorize } from "@/lib/auth";
import { fail, failure } from "@/lib/http";
import { addResume, listResumes } from "@/lib/resume";
import { looksLikePdf, MAX_RESUME_BYTES, resumeProblem, safeFileName, tooLarge } from "@/lib/rules";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ userId: string }> };

/** Resumes the user has uploaded, newest first. */
export async function GET(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  try {
    return Response.json({ resumes: await listResumes(userId) });
  } catch (err) {
    return failure(err);
  }
}

/** Upload a resume PDF; answers once the agent has added the candidate. */
export async function POST(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  if (tooLarge(request, MAX_RESUME_BYTES)) return fail("Keep your resume under 10 MB.", 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return fail("Choose a PDF to upload.", 400);
  const problem = resumeProblem(file);
  if (problem) return fail(problem, 400);
  if (!looksLikePdf(new Uint8Array(await file.slice(0, 5).arrayBuffer()))) return fail("Upload your resume as a PDF.", 400);
  try {
    const named = new File([file], safeFileName(file.name, "resume.pdf"), { type: "application/pdf" });
    return Response.json({ resume: await addResume(userId, named) });
  } catch (err) {
    return failure(err);
  }
}
