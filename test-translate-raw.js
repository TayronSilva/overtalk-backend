async function test() {
    try {
        const text = encodeURIComponent("Hello world");
        const url = `https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${text}`;
        const res = await fetch(url);
        const json = await res.json();
        console.log("Success:", json[0][0][0]);
    } catch (e) {
        console.error("Error:", e.message);
    }
}
test();
