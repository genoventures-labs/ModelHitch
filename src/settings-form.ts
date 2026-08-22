import {
  CONFIG_VERSION,
  validateConfig,
  type ImageGenerationConfig,
  type ModelHitchConfig,
} from './config.js';

export interface SettingsFormState {
  defaultProviderId: string;
  defaultModel: string;
  imageEnabled: boolean;
  imageProvider: 'openai' | 'gemini';
  imageModel: string;
  imageQuality: 'low' | 'medium';
  imageSize: string;
  cooldownType: 'none' | 'memory' | 'circuit-breaker';
  failureThreshold: string;
  baseTripMs: string;
  maxTripMs: string;
}

export function configToSettingsForm(config: ModelHitchConfig): SettingsFormState {
  const image = config.imageGeneration;
  const cooldown = config.cooldown;
  return {
    defaultProviderId: config.defaultProviderId ?? '',
    defaultModel: config.defaultModel ?? '',
    imageEnabled: image?.enabled ?? false,
    imageProvider: image?.providerId ?? 'openai',
    imageModel: image?.model ?? 'gpt-image-2',
    imageQuality: image?.quality === 'low' ? 'low' : 'medium',
    imageSize: image?.size ?? '1024x1024',
    cooldownType: cooldown?.type ?? 'none',
    failureThreshold: cooldown?.type === 'circuit-breaker' ? String(cooldown.failureThreshold ?? 3) : '3',
    baseTripMs: cooldown?.type === 'circuit-breaker' ? String(cooldown.baseTripMs ?? 15_000) : '15000',
    maxTripMs: cooldown?.type === 'circuit-breaker' ? String(cooldown.maxTripMs ?? 120_000) : '120000',
  };
}

function optionalPositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer.`);
  return parsed;
}

function optionalNonNegativeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
  return parsed;
}

export function applySettingsForm(config: ModelHitchConfig, form: SettingsFormState): ModelHitchConfig {
  const next: ModelHitchConfig = JSON.parse(JSON.stringify(config)) as ModelHitchConfig;
  next.version = CONFIG_VERSION;

  const defaultProviderId = form.defaultProviderId.trim();
  const defaultModel = form.defaultModel.trim();
  if (defaultProviderId) next.defaultProviderId = defaultProviderId;
  else delete next.defaultProviderId;
  if (defaultModel) next.defaultModel = defaultModel;
  else delete next.defaultModel;

  const image: ImageGenerationConfig = {
    enabled: form.imageEnabled,
    providerId: form.imageProvider,
    model: form.imageModel.trim(),
    quality: form.imageProvider === 'openai' ? form.imageQuality : undefined,
    size: form.imageSize.trim(),
  };
  next.imageGeneration = image;

  if (form.cooldownType === 'none') {
    delete next.cooldown;
  } else if (form.cooldownType === 'memory') {
    next.cooldown = { type: 'memory' };
  } else {
    next.cooldown = {
      type: 'circuit-breaker',
      failureThreshold: optionalPositiveInteger(form.failureThreshold, 'Failure threshold'),
      baseTripMs: optionalNonNegativeInteger(form.baseTripMs, 'Base trip ms'),
      maxTripMs: optionalNonNegativeInteger(form.maxTripMs, 'Maximum trip ms'),
    };
  }

  const validation = validateConfig(next);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  return next;
}