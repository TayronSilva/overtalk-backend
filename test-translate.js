import { translate } from 'google-translate-api-x';

async function test() {
    try {
        const res = await translate("Hello world", { to: 'pt' });
        console.log("Success:", res.text);
    } catch (e) {
        console.error("Error:", e.message);
        console.error(e);
    }
}

test();
