import qrcode from 'qrcode-generator';

/**
 * Encode an `otpauth://` URI as a QR data URL (ADR-041, ADR-042).
 *
 * Deliberately **not** inside the component: this is the whole of the encoding logic, and testing it
 * as a plain function means the test proves the encoder rather than working around the JIT harness's
 * inability to bind a signal input. The component is then a two-line wrapper.
 *
 * Type number 0 lets the generator pick the smallest version that fits; error-correction level `M` is
 * the usual trade (about 15 % recoverable) and keeps the code small enough to scan from a laptop
 * screen. An empty URI returns an empty string rather than a QR code of nothing.
 */
export function qrDataUrl(uri: string): string {
  if (uri === '') return '';
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return qr.createDataURL(6, 2);
}
