"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import {
  addMcpServer,
  createChallenge,
  deleteChallenge,
  removeMcpServer,
  saveSettings,
  type SettingsInput,
} from "@/lib/challenges";

export type FormState = { error: string; saved?: boolean };

export async function create(_prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Give the challenge a name." };
  const email = (await currentUser())?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "";
  if (!email) return { error: "Sign in first." };
  let id: string;
  try {
    id = await createChallenge(name, email);
  } catch (err) {
    return { error: (err as Error).message };
  }
  redirect(`/c/${id}/settings`);
}

export async function save(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const number = (key: string) => Number(text(key) || 0);
  const input: SettingsInput = {
    name: text("name"),
    private_notes: text("private_notes"),
    public_notes: text("public_notes"),
    guests: form.get("guests") === "on",
    guest_emails: text("guest_emails")
      .split(/[\n,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean),
    model: text("model"),
    max_tokens: number("max_tokens"),
    web_search: form.get("web_search") === "on",
    url_fetch: form.get("url_fetch") === "on",
    monthly_spend_limit: number("monthly_spend_limit"),
    openrouter_api_key: text("openrouter_api_key"),
    brave_api_key: text("brave_api_key"),
    searxng_url: text("searxng_url"),
    searxng_token: text("searxng_token"),
  };
  if (!input.name) return { error: "Give the challenge a name." };
  if (!Number.isFinite(input.max_tokens) || input.max_tokens < 0) return { error: "Max reply tokens must be 0 or more." };
  if (!Number.isFinite(input.monthly_spend_limit) || input.monthly_spend_limit < 0) {
    return { error: "The spend limit must be 0 or more." };
  }
  try {
    await saveSettings(id, input);
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath(`/c/${id}`, "layout");
  return { error: "", saved: true };
}

export async function remove(id: string): Promise<void> {
  await deleteChallenge(id);
  revalidatePath("/");
  redirect("/");
}

export async function addMcp(id: string, _prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const header = String(form.get("header_name") ?? "").trim();
  const value = String(form.get("header_value") ?? "").trim();
  if (!name || !url) return { error: "Name and URL are required." };
  try {
    await addMcpServer(id, { name, url, headers: header && value ? { [header]: value } : {} });
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath(`/c/${id}/settings`);
  return { error: "" };
}

export async function removeMcp(id: string, serverId: string): Promise<void> {
  await removeMcpServer(id, serverId);
  revalidatePath(`/c/${id}/settings`);
}
