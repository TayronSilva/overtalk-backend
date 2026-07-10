// Pré-carrega o modelo Whisper durante o build da imagem Docker
// para que o startup seja instantâneo em produção.
import { pipeline } from '@huggingface/transformers';

console.log("📥 Pré-carregando modelo Whisper-Tiny...");
await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
    progress_callback: (data) => {
        if (data.status === 'progress') {
            process.stdout.write(`\r📥 ${data.file}: ${(data.progress || 0).toFixed(1)}%`);
        }
    }
});
console.log("\n✅ Modelo pré-carregado com sucesso!");
