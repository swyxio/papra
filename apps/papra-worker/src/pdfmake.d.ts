declare module 'pdfmake/build/pdfmake.js' {
  const pdfmake: {addVirtualFileSystem(fonts:Record<string,string>):void; createPdf(definition:Record<string,unknown>):{getBuffer():Promise<Uint8Array>}};
  export default pdfmake;
}
declare module 'pdfmake/build/vfs_fonts.js' {const fonts:Record<string,string>;export default fonts;}
