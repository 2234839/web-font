const server=location.href
export function get_font(font:string, text:string) {
  return new Promise((rs, re) => {
    var xhr = new XMLHttpRequest();
    xhr.addEventListener('readystatechange', function() {
      if (this.readyState === 4) {
        rs(JSON.parse(this.responseText)[0]);
      }
    });
    xhr.open(
      'GET',
      `${server}fontmin?font=${encodeURIComponent(
        font,
      )}&text=${encodeURIComponent(text)}`,
    );
    xhr.onerror=re
    xhr.send();
  })
}
export function get_font_list(font:string, text:string) {
  return new Promise((rs, re) => {
    var xhr = new XMLHttpRequest();
    xhr.addEventListener('readystatechange', function() {
      if (this.readyState === 4) {
        rs(JSON.parse(this.responseText));
      }
    });
    xhr.open(
      'GET',
      `${server}font_list`,
    );
    xhr.onerror=re
    xhr.send();
  })
}
