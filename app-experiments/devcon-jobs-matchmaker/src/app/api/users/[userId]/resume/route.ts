import { authorize } from "@/lib/auth";
import { fail, failure } from "@/lib/http";
import { addResume, listResumes } from "@/lib/resume";
import {
  looksLikePdf,
  partProblem,
  RESUME_PART_BYTES,
  resumeProblem,
  resumeUpdatableAt,
  safeFileName,
  tooLarge,
  type ResumePart,
} from "@/lib/rules";
import { savePart } from "@/lib/upload";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ userId: string }> };

/** Resumes the user has uploaded, newest first, and when they may next upload one. */
export async function GET(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  try {
    const resumes = await listResumes(userId);
    const updatableAt = resumes[0] ? resumeUpdatableAt(resumes[0].createdAt) : null;
    return Response.json({ resumes, updatableAt });
  } catch (err) {
    return failure(err);
  }
}

/**
 * Upload one part of a resume PDF (see RESUME_PART_BYTES). Answers `{ received }` for
 * each part, and once the last is in, joins them and answers when the agent has added
 * the candidate.
 */
export async function POST(request: Request, { params }: Ctx) {
  const userId = await authorize(request, (await params).userId);
  if (userId instanceof Response) return userId;
  if (tooLarge(request, RESUME_PART_BYTES)) return fail("That upload is not valid. Try again.", 413);
  const form = await request.formData().catch(() => null);
  const chunk = form?.get("file");
  if (!(chunk instanceof Blob)) return fail("Choose a PDF to upload.", 400);
  const meta: ResumePart = {
    uploadId: String(form?.get("uploadId") ?? ""),
    part: Number(form?.get("part")),
    parts: Number(form?.get("parts")),
    size: Number(form?.get("size")),
    name: safeFileName(String(form?.get("name") ?? ""), "resume.pdf"),
  };
  const problem = resumeProblem({ name: meta.name, type: chunk.type, size: meta.size }) ?? partProblem(meta, chunk.size);
  if (problem) return fail(problem, 400);
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  if (meta.part === 0 && !looksLikePdf(bytes)) return fail("Upload your resume as a PDF.", 400);
  try {
    const file = await savePart(userId, meta, bytes);
    if (!file) return Response.json({ received: meta.part });
    return Response.json({ resume: await addResume(userId, file) });
  } catch (err) {
    return failure(err);
  }
}
