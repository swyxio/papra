// The former Documenso hostname now opens Papra's native signing workflow.
// Legacy Documenso test links are retired; their artifacts are privately archived.
export default {
  fetch() {
    return new Response(null, {status:302, headers:{
      Location:'https://drive.swyx.io/sign',
      'Cache-Control':'no-store',
      'Referrer-Policy':'no-referrer',
    }});
  },
};
