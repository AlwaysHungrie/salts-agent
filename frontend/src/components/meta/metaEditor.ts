import type {
  Capability,
  CapabilityField,
  Config,
  MetaSettings,
  MetaTunableKey,
  ModelOption,
} from "@/lib/agent";

/**
 * The form's seam: before the agent exists values are meta defaults; after, the agent's
 * own `Config`. `valueOf`/`setValue` hide which, so the form is written once.
 */
export function metaEditor({
  meta,
  onChange,
  config,
  onConfigChange,
  models,
  capabilities,
}: {
  meta: MetaSettings;
  onChange: (next: MetaSettings) => void;
  config?: Config | null;
  onConfigChange?: (patch: Partial<Config>) => void;
  models: ModelOption[];
  capabilities: Capability[];
}) {
  /** Whether the settings on screen belong to an agent that exists. */
  const live = !!config && !!onConfigChange;

  const patch = (next: Partial<MetaSettings>) => onChange({ ...meta, ...next });

  /** Only settings actually touched are recorded; the rest start on the factory value. */
  const setDefault = (key: MetaTunableKey, value: unknown) =>
    patch({ defaults: { ...meta.defaults, [key]: value } });

  const setCapabilityDefault = (
    id: string,
    next: { enabled?: boolean; field?: { key: string; value: string } },
  ) => {
    const entry = { ...(meta.capabilities[id] ?? {}) };
    if (next.enabled !== undefined) entry.enabled = next.enabled;
    if (next.field) {
      entry.fields = { ...(entry.fields ?? {}) };
      if (next.field.value === "") delete entry.fields[next.field.key];
      else entry.fields[next.field.key] = next.field.value;
    }
    patch({ capabilities: { ...meta.capabilities, [id]: entry } });
  };

  const isLocked = (key: string) => meta.locked.includes(key);
  const setLocked = (key: string, on: boolean) =>
    patch({
      locked: on ? [...meta.locked, key] : meta.locked.filter((k) => k !== key),
    });
  /** The lock props a section needs, so every section wires it the same way. */
  const lock = (key: string) => ({
    lockKey: key,
    locked: isLocked(key),
    onLock: (v: boolean) => setLocked(key, v),
  });

  /** One tuning setting as it stands: the agent's own value, or its chosen default. */
  const valueOf = <K extends MetaTunableKey>(key: K): Config[K] | undefined =>
    live ? config[key] : (meta.defaults[key] as Config[K] | undefined);

  const setValue = (key: MetaTunableKey, value: unknown) => {
    if (live) onConfigChange({ [key]: value } as Partial<Config>);
    else setDefault(key, value);
  };

  const capabilityOn = (capability: Capability) =>
    live
      ? !!config[capability.flag]
      : (meta.capabilities[capability.id]?.enabled ?? false);

  const setCapabilityOn = (capability: Capability, on: boolean) => {
    if (live)
      onConfigChange({ [capability.flag]: on ? 1 : 0 } as Partial<Config>);
    else setCapabilityDefault(capability.id, { enabled: on });
  };

  const fieldValue = (capability: Capability, key: string) =>
    live
      ? String(config[key as keyof Config] ?? "")
      : (meta.capabilities[capability.id]?.fields?.[key] ?? "");

  const setFieldValue = (capability: Capability, key: string, value: string) => {
    if (live) onConfigChange({ [key]: value } as Partial<Config>);
    else setCapabilityDefault(capability.id, { field: { key, value } });
  };

  /** The models on offer: the list above, or the deployment's catalogue while it is empty. */
  const offeredModels: ModelOption[] = meta.models.length
    ? meta.models.map(({ id, vision }) => ({
        id,
        label: models.find((m) => m.id === id)?.label ?? id,
        vision,
      }))
    : models;

  /** What a fixed-choice field may be set to: the widened list, or what it ships with. */
  const optionsFor = (field: CapabilityField): string[] => {
    const widened = meta.field_options[String(field.key)] ?? [];
    return widened.length ? widened : (field.options ?? []).map((o) => o.value);
  };

  /** Every fixed-choice field any capability declares: the image and audio models. */
  const choiceFields = capabilities.flatMap((c) =>
    c.fields.filter((f) => f.options && f.options.length > 0),
  );

  const setFieldOptions = (field: CapabilityField, values: string[]) =>
    patch({
      field_options: { ...meta.field_options, [String(field.key)]: values },
    });

  /** The editor a capability field gets, with its choices widened to this agent's. */
  const fieldFor = (field: CapabilityField): CapabilityField => {
    if (!field.options) return field;
    return {
      ...field,
      options: optionsFor(field).map((value) => ({
        value,
        label: field.options?.find((o) => o.value === value)?.label ?? value,
      })),
    };
  };

  return {
    meta,
    live,
    patch,
    isLocked,
    setLocked,
    lock,
    valueOf,
    setValue,
    capabilityOn,
    setCapabilityOn,
    fieldValue,
    setFieldValue,
    offeredModels,
    choiceFields,
    setFieldOptions,
    fieldFor,
  };
}

export type MetaEditor = ReturnType<typeof metaEditor>;
