import { Field, Toggle } from "@/components/CapabilitySection";
import type { Capability } from "@/lib/agent";
import type { MetaEditor } from "./metaEditor";
import { LockButton, Section } from "./pieces";

/** One capability: its switch, its lock, and its fields once it is on. */
function CapabilityCard({
  capability,
  editor,
}: {
  capability: Capability;
  editor: MetaEditor;
}) {
  const on = editor.capabilityOn(capability);
  return (
    <div className="bg-canvas-soft rounded-2xl px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-[1.43]">
            {capability.label}
          </span>
          <span className="text-faint block text-xs leading-[1.33]">
            {capability.alwaysOn
              ? "Always on; its own configuration decides what it does."
              : capability.summary}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <LockButton
            locked={editor.isLocked(capability.id)}
            onChange={(v) => editor.setLocked(capability.id, v)}
            what={capability.label}
          />
          {!capability.alwaysOn && (
            <Toggle
              on={on}
              onChange={(v) => editor.setCapabilityOn(capability, v)}
            />
          )}
        </span>
      </div>
      {capability.fields.length > 0 && (on || capability.alwaysOn) && (
        <div className="mt-3 space-y-3">
          {capability.fields.map((field) => {
            const key = String(field.key);
            return (
              <Field
                key={key}
                field={editor.fieldFor(field)}
                value={editor.fieldValue(capability, key)}
                onChange={(v) => editor.setFieldValue(capability, key, v)}
                bordered
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CapabilitiesSection({
  editor,
  capabilities,
}: {
  editor: MetaEditor;
  capabilities: Capability[];
}) {
  return (
    <Section
      title="Capabilities"
      hint="What this agent can do besides write, and the credentials each one needs."
    >
      <div className="space-y-2">
        {capabilities.map((capability) => (
          <CapabilityCard
            key={capability.id}
            capability={capability}
            editor={editor}
          />
        ))}
      </div>
    </Section>
  );
}
