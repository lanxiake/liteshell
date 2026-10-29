// Vendored from tabby-rdp 0.5.7 (MIT), file dist/byteQueue.js.
// @ts-nocheck -- vendored JavaScript; the fields are assigned in the constructor.
/**
 * Bytes from a stream, kept as they arrived and taken off the front a whole message at a time. Joining each arrival
 * onto all that is still waiting copies all of it again every time: a message that comes a byte at a time (a server
 * can send one-byte TLS records) costs the square of its size, on the thread that runs Tabby's window. Here a byte is
 * copied in once, as it arrives, and at most once more, when the message it is in is taken.
 *
 * What arrives is copied into storage of the queue's own rather than kept as it came: a piece can be a few bytes of a
 * much larger buffer (a TLS record that also held other frames, say), and keeping the piece would keep all of that
 * buffer too. A sender that had each record add a byte to a message it never finishes could otherwise have a whole
 * record kept for every byte. So the queue holds what is waiting, and at most two slabs more.
 */
export class ByteQueue {
    constructor() {
        /** Storage, oldest first: what is waiting runs from `offset` in the first slab to `filled` in the last. */
        this.slabs = [];
        this.offset = 0;
        this.filled = 0;
        /** How many bytes are waiting. */
        this.length = 0;
    }
    push(chunk) {
        for (let at = 0; at < chunk.length;) {
            let last = this.slabs[this.slabs.length - 1];
            if (!last || this.filled === last.length) {
                if (!this.length) {
                    // Nothing is waiting: the slabs there are only hold what was taken.
                    this.slabs = [];
                    this.offset = 0;
                }
                // Not from Node's pool, whose slabs are shared with whatever else is small.
                last = Buffer.allocUnsafeSlow(ByteQueue.SLAB);
                this.slabs.push(last);
                this.filled = 0;
            }
            const n = Math.min(chunk.length - at, last.length - this.filled);
            last.set(chunk.subarray(at, at + n), this.filled);
            this.filled += n;
            this.length += n;
            at += n;
        }
    }
    /** Where what is waiting in slab `i` ends. */
    endOf(i) {
        return i === this.slabs.length - 1 ? this.filled : this.slabs[i].length;
    }
    /** The first `n` bytes (or all there are, if fewer), left in place: for a header, so `n` is small. */
    peek(n) {
        n = Math.min(n, this.length);
        if (!n) {
            return Buffer.alloc(0);
        }
        if (this.endOf(0) - this.offset >= n) {
            return this.slabs[0].subarray(this.offset, this.offset + n);
        }
        const out = Buffer.alloc(n);
        for (let i = 0, copied = 0; copied < n; i++) {
            const from = i ? 0 : this.offset;
            copied += this.slabs[i].copy(out, copied, from, Math.min(this.endOf(i), from + n - copied));
        }
        return out;
    }
    /**
     * Takes the first `n` bytes (at most all there are): part of the slab they are in when they are in one, else a
     * copy, made once. What is written to a slab stays as it is, so such a part doesn't change after it is taken.
     */
    take(n) {
        n = Math.min(n, this.length);
        if (!n) {
            return Buffer.alloc(0);
        }
        let out;
        if (this.endOf(0) - this.offset >= n) {
            out = this.slabs[0].subarray(this.offset, this.offset + n);
            this.offset += n;
        }
        else {
            out = Buffer.allocUnsafe(n);
            for (let copied = 0; copied < n;) {
                const end = Math.min(this.endOf(0), this.offset + n - copied);
                copied += this.slabs[0].copy(out, copied, this.offset, end);
                this.offset = end;
                if (copied < n) {
                    this.slabs.shift();
                    this.offset = 0;
                }
            }
        }
        this.length -= n;
        // A slab whose bytes have all been taken is let go, unless it is the one being filled.
        if (this.offset === this.endOf(0) && this.slabs.length > 1) {
            this.slabs.shift();
            this.offset = 0;
        }
        return out;
    }
}
/** How large each slab of storage is. */
ByteQueue.SLAB = 64 * 1024;
