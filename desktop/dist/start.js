// Проверяем, что сайт отвечает, и открываем покер в этом же окне. Нет ответа за 8 секунд — «Нет связи».
// (Ответ сайта не читаем — достаточно, что сеть до него есть.)
const HOME = "https://alexandertarakanov.app/poker/";

async function go() {
  document.getElementById("checking").hidden = false;
  document.getElementById("offline").hidden = true;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  try {
    await fetch(HOME + "api/health?t=" + Date.now(), { mode: "no-cors", cache: "no-store", signal: stop.signal });
    location.replace(HOME);
  } catch (e) {
    document.getElementById("checking").hidden = true;
    document.getElementById("offline").hidden = false;
    document.getElementById("retry").focus();
  } finally {
    clearTimeout(timer);
  }
}
document.getElementById("retry").onclick = go;
window.addEventListener("online", go);
go();
