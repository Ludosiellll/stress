import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
  AudioNodeLike,
  GainNodeLike,
} from '../runtime/audio/audioOut';

/** A node that only remembers where it is connected. */
class FakeNode implements AudioNodeLike {
  connectedTo: AudioNodeLike[] = [];
  disconnects = 0;

  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination);
  }

  disconnect(): void {
    this.disconnects++;
    this.connectedTo = [];
  }
}

export class FakeBuffer implements AudioBufferLike {
  readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void {
    this.channels[channel]?.set(source);
  }
}

export class FakeSource extends FakeNode implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  starts: { when: number; offset: number }[] = [];
  stops = 0;

  start(when: number, offset: number): void {
    this.starts.push({ when, offset });
  }

  stop(): void {
    this.stops++;
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  /** Every setTargetAtTime call, in order. */
  readonly targets: { target: number; at: number; timeConstant: number }[] = [];
  readonly gain = {
    value: 1,
    setTargetAtTime: (target: number, at: number, timeConstant: number): void => {
      this.targets.push({ target, at, timeConstant });
    },
  };
}

export interface FakeAudioOptions {
  /** Whether resume() brings the context to 'running' (default) or rejects, as a blocked device does. */
  resumes?: boolean;
  state?: AudioContextState;
}

/** AudioContext double for the player tests: records buffers, sources and gains instead of playing. */
export class FakeAudioContext implements AudioContextLike {
  state: AudioContextState;
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly buffers: FakeBuffer[] = [];
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  resumeCalls = 0;
  private readonly resumes: boolean;

  constructor(o: FakeAudioOptions = {}) {
    this.state = o.state ?? 'suspended';
    this.resumes = o.resumes ?? true;
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (!this.resumes) return Promise.reject(new Error('NotAllowedError'));
    this.state = 'running';
    return Promise.resolve();
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const b = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }

  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }

  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
}
