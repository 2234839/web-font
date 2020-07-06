export const server = '//' + location.host + location.pathname;
/** get 方式压缩字体 */
export function get_font(font: string, text: string) {
  return new Promise((rs, re) => {
    var xhr = new XMLHttpRequest();
    xhr.addEventListener('readystatechange', function() {
      if (this.readyState === 4) {
        rs(this.responseText);
      }
    });
    xhr.open(
      'GET',
      `${server}fontmin?font=${encodeURIComponent(
        font,
      )}&text=${encodeURIComponent(text)}`,
    );
    xhr.onerror = re;
    xhr.send();
  });
}
/** post 方式压缩字体 */
export function post_fontmin(par:{font:string,text:string}[]) {
  return new Promise((rs, re) => {
    var data = JSON.stringify(par);
    var xhr = new XMLHttpRequest();
    xhr.addEventListener('readystatechange', function() {
      if (this.readyState === 4) {
        rs(JSON.parse(this.responseText) );
      }
    });
    xhr.open('POST', `${server}fontmin`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onerror = re;
    xhr.send(data);
  });
}
export function get_font_list(font: string, text: string) {
  return new Promise((rs, re) => {
    var xhr = new XMLHttpRequest();
    xhr.addEventListener('readystatechange', function() {
      if (this.readyState === 4) {
        rs(JSON.parse(this.responseText));
      }
    });
    xhr.open('GET', `${server}font_list`);
    xhr.onerror = re;
    xhr.send();
  });
}
