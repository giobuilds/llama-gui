import { z } from 'zod'

/**
 * What this machine can actually do, learned from runs the app already performs.
 *
 * A single measurement gives only bandwidth, and only if you assume per-token
 * overhead is zero. Two or more measurements at different model sizes give both:
 * time per token is `overhead + bytes / bandwidth`, a straight line whose slope
 * is the reciprocal of bandwidth and whose intercept is the fixed cost that caps
 * small models. Fitting it beats assuming a ceiling, which would otherwise be a
 * guess about hardware nobody has measured.
 */

export const sampleSchema = z.object({
  /** Weights read per token — for a mixture of experts, far less than the file. */
  activeBytes: z.number().positive(),
  secondsPerToken: z.number().positive(),
  /** Whether the weights were resident on the GPU during the measurement. */
  onGpu: z.boolean(),
  at: z.number()
})

export type Sample = z.infer<typeof sampleSchema>

export const calibrationSchema = z.object({
  samples: z.array(sampleSchema).default([]),
  updatedAt: z.number().default(0)
})

export type Calibration = z.infer<typeof calibrationSchema>

export const EMPTY_CALIBRATION: Calibration = { samples: [], updatedAt: 0 }

/** Keep enough to fit a line without letting the file grow without bound. */
const MAX_SAMPLES_PER_DEVICE = 12
/** Sizes within this ratio describe the same point on the line. */
const SAME_SIZE_RATIO = 1.15

/**
 * Fold a measurement in, keeping the fastest result seen at each size.
 *
 * The fastest is kept rather than an average because a slow sample means
 * something else was competing for the device, not that the machine is slower.
 */
export function addSample(calibration: Calibration, sample: Sample): Calibration {
  const others = calibration.samples.filter(
    (s) =>
      s.onGpu !== sample.onGpu ||
      s.activeBytes > sample.activeBytes * SAME_SIZE_RATIO ||
      s.activeBytes < sample.activeBytes / SAME_SIZE_RATIO
  )
  const sameSize = calibration.samples.filter((s) => !others.includes(s))
  const fastest = [...sameSize, sample].reduce((best, s) =>
    s.secondsPerToken < best.secondsPerToken ? s : best
  )

  const kept = [...others, fastest]
  const gpu = kept.filter((s) => s.onGpu).slice(-MAX_SAMPLES_PER_DEVICE)
  const cpu = kept.filter((s) => !s.onGpu).slice(-MAX_SAMPLES_PER_DEVICE)
  return { samples: [...gpu, ...cpu], updatedAt: Date.now() }
}

export interface DerivedProfile {
  gpuBytesPerSecond: number | null
  cpuBytesPerSecond: number | null
  /** Throughput small models converge on, where overhead rather than size rules. */
  ceilingTokensPerSecond: number | null
  gpuSamples: number
  cpuSamples: number
}

export function derive(calibration: Calibration): DerivedProfile {
  const gpu = fit(calibration.samples.filter((s) => s.onGpu))
  const cpu = fit(calibration.samples.filter((s) => !s.onGpu))
  return {
    gpuBytesPerSecond: gpu.bytesPerSecond,
    cpuBytesPerSecond: cpu.bytesPerSecond,
    ceilingTokensPerSecond: gpu.ceilingTokensPerSecond,
    gpuSamples: calibration.samples.filter((s) => s.onGpu).length,
    cpuSamples: calibration.samples.filter((s) => !s.onGpu).length
  }
}

/**
 * Least squares over `t = overhead + bytes / bandwidth`.
 *
 * With one sample, or several of near-identical size, the line is
 * underdetermined: overhead is taken as zero and the whole time attributed to
 * bandwidth, which is the conservative reading — it understates bandwidth
 * slightly rather than inventing an overhead figure.
 */
function fit(samples: Sample[]): { bytesPerSecond: number | null; ceilingTokensPerSecond: number | null } {
  if (samples.length === 0) return { bytesPerSecond: null, ceilingTokensPerSecond: null }
  if (samples.length === 1) {
    const s = samples[0]!
    return { bytesPerSecond: s.activeBytes / s.secondsPerToken, ceilingTokensPerSecond: null }
  }

  const n = samples.length
  const sumX = samples.reduce((t, s) => t + s.activeBytes, 0)
  const sumY = samples.reduce((t, s) => t + s.secondsPerToken, 0)
  const sumXY = samples.reduce((t, s) => t + s.activeBytes * s.secondsPerToken, 0)
  const sumXX = samples.reduce((t, s) => t + s.activeBytes * s.activeBytes, 0)
  const denominator = n * sumXX - sumX * sumX

  // Sizes too close together to separate overhead from bandwidth.
  if (denominator <= 0 || !Number.isFinite(denominator)) {
    const best = samples.reduce((b, s) =>
      s.activeBytes / s.secondsPerToken > b.activeBytes / b.secondsPerToken ? s : b
    )
    return { bytesPerSecond: best.activeBytes / best.secondsPerToken, ceilingTokensPerSecond: null }
  }

  const slope = (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n

  /**
   * The intercept is per-token overhead, and it is only trustworthy when the
   * samples actually constrain it: two points far from the origin will fit a
   * line through them and put the intercept wherever the noise wants. Measured
   * here, two large models implied a 1906 tok/s ceiling where small models
   * showed roughly 630. So a ceiling is claimed only from three or more samples
   * spanning a wide range of sizes; otherwise the model is left uncapped, which
   * only affects predictions for very small models.
   */
  const sizes = samples.map((sm) => sm.activeBytes)
  const span = Math.max(...sizes) / Math.min(...sizes)
  const interceptTrustworthy = n >= 3 && span >= 5

  // A non-positive slope would mean bigger models run faster, which means the
  // samples are noise rather than a trend; fall back to the best single point.
  if (slope <= 0) {
    const best = samples.reduce((b, s) =>
      s.activeBytes / s.secondsPerToken > b.activeBytes / b.secondsPerToken ? s : b
    )
    return { bytesPerSecond: best.activeBytes / best.secondsPerToken, ceilingTokensPerSecond: null }
  }

  return {
    bytesPerSecond: 1 / slope,
    // A non-positive intercept means overhead is not measurable here, so no
    // ceiling is claimed rather than one being extrapolated from noise.
    ceilingTokensPerSecond: interceptTrustworthy && intercept > 0 ? 1 / intercept : null
  }
}
