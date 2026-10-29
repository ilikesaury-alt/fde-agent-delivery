/** Vite `?url` 导入的类型声明（pdf.js worker 走 URL 形式加载） */
declare module "*?url" {
  const url: string;
  export default url;
}
