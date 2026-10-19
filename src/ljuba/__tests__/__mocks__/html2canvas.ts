export default function html2canvas(): Promise<HTMLCanvasElement> {
  return Promise.resolve(document.createElement('canvas'));
}
