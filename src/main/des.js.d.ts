/** Minimal shape of `des.js` used here: raw 8-byte-block DES, no padding. */
declare module 'des.js' {
  interface DesCipher {
    update(data: Uint8Array): number[]
    final(): number[] | null
  }

  const des: {
    DES: new (options: { type: 'encrypt' | 'decrypt'; key: Uint8Array }) => DesCipher
  }

  export = des
}
