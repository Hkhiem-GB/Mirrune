class MirruneOpusPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.queue = [];
        this.queuedFrames = 0;
        this.maxQueuedFrames = 2880; // 60 ms at 48 kHz
        this.current = null;
        this.currentOffset = 0;
        this.gain = 1;
        this.lastLeft = 0;
        this.lastRight = 0;
        this.fadeStep = 1 / 240; // 5 ms at 48 kHz; masks abrupt underrun edges.

        this.port.onmessage = (event) => {
            const message = event.data;

            if (!message || typeof message !== "object") {
                return;
            }

            if (message.type === "flush") {
                this.queue = [];
                this.queuedFrames = 0;
                this.current = null;
                this.currentOffset = 0;
                this.gain = 0;
                this.lastLeft = 0;
                this.lastRight = 0;
                return;
            }

            if (
                message.type !== "audio" ||
                !(message.left instanceof Float32Array) ||
                !(message.right instanceof Float32Array)
            ) {
                return;
            }

            const frames = Math.min(message.left.length, message.right.length);

            if (frames === 0) {
                return;
            }

            this.queue.push({
                left: message.left,
                right: message.right,
                frames,
            });
            this.queuedFrames += frames;

            // Keep latency bounded. Drop the oldest queued PCM if the renderer
            // falls behind instead of allowing memory and delay to grow forever.
            while (this.queuedFrames > this.maxQueuedFrames && this.queue.length > 1) {
                const dropped = this.queue.shift();
                this.queuedFrames -= dropped.frames;
            }
        };
    }

    process(_inputs, outputs) {
        const output = outputs[0];

        if (!output || output.length === 0) {
            return true;
        }

        const leftOutput = output[0];
        const rightOutput = output[1] || output[0];

        leftOutput.fill(0);
        if (rightOutput !== leftOutput) {
            rightOutput.fill(0);
        }

        let written = 0;

        while (written < leftOutput.length) {
            if (!this.current) {
                this.current = this.queue.shift() || null;
                this.currentOffset = 0;

                if (!this.current) {
                    // Fade the last sample to silence over 5 ms rather than
                    // cutting the waveform abruptly when the PCM queue underruns.
                    for (let i = written; i < leftOutput.length; i += 1) {
                        this.gain = Math.max(0, this.gain - this.fadeStep);
                        this.lastLeft *= this.gain > 0 ? 1 : 0;
                        this.lastRight *= this.gain > 0 ? 1 : 0;
                        leftOutput[i] = this.lastLeft * this.gain;
                        if (rightOutput !== leftOutput) {
                            rightOutput[i] = this.lastRight * this.gain;
                        }
                    }
                    break;
                }

                this.queuedFrames -= this.current.frames;
            }

            const available = this.current.frames - this.currentOffset;
            const count = Math.min(available, leftOutput.length - written);

            for (let i = 0; i < count; i += 1) {
                this.gain = Math.min(1, this.gain + this.fadeStep);
                const left = this.current.left[this.currentOffset + i];
                const right = this.current.right[this.currentOffset + i];
                this.lastLeft = left;
                this.lastRight = right;
                leftOutput[written + i] = left * this.gain;
                if (rightOutput !== leftOutput) {
                    rightOutput[written + i] = right * this.gain;
                }
            }

            this.currentOffset += count;
            written += count;

            if (this.currentOffset >= this.current.frames) {
                this.current = null;
                this.currentOffset = 0;
            }
        }

        return true;
    }
}

registerProcessor("mirrune-opus-playback", MirruneOpusPlaybackProcessor);
