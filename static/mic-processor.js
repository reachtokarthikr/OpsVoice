/**
 * AudioWorklet processor for microphone capture.
 * Runs on a dedicated audio thread — avoids main-thread jank
 * that ScriptProcessorNode causes.
 *
 * Receives float32 PCM frames, downsamples to 16 kHz,
 * computes RMS for voice-activity detection, and posts
 * the result to the main thread.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._targetRate = 16000;
    this._inputRate = options.processorOptions?.inputSampleRate || sampleRate;
    // Accumulate samples until we have enough for a ~4096-sample output chunk
    this._buffer = new Float32Array(0);
    this._chunkSize = 4096;
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    // Append to accumulation buffer
    const merged = new Float32Array(this._buffer.length + input.length);
    merged.set(this._buffer);
    merged.set(input, this._buffer.length);
    this._buffer = merged;

    // Process when we have enough samples
    const ratio = this._inputRate / this._targetRate;
    const neededInput = Math.ceil(this._chunkSize * ratio);
    if (this._buffer.length < neededInput) return true;

    // Take exactly neededInput samples
    const chunk = this._buffer.slice(0, neededInput);
    this._buffer = this._buffer.slice(neededInput);

    // Compute RMS on original samples
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) {
      sum += chunk[i] * chunk[i];
    }
    const rms = Math.sqrt(sum / chunk.length);

    // Downsample
    const outLen = Math.round(chunk.length / ratio);
    const downsampled = new Float32Array(outLen);
    for (let o = 0; o < outLen; o++) {
      const start = Math.round(o * ratio);
      const end = Math.min(Math.round((o + 1) * ratio), chunk.length);
      let s = 0, c = 0;
      for (let i = start; i < end; i++) { s += chunk[i]; c++; }
      downsampled[o] = c > 0 ? s / c : 0;
    }

    // Convert float32 → int16 PCM
    const pcm = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
      const v = Math.max(-1, Math.min(1, downsampled[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
