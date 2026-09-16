"""
Script auxiliar para generar una muestra de audio .wav de prueba básica
usando únicamente la librería estándar de Python (wave y math).
"""
import math
import wave
import struct
from pathlib import Path

OUTPUT_PATH = Path(__file__).resolve().parent / "voices" / "sample_voice.wav"

def generate_tone():
    sample_rate = 22050
    duration_sec = 4.0
    freq1 = 220.0  # La3
    freq2 = 440.0  # La4
    
    num_samples = int(sample_rate * duration_sec)
    
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    
    with wave.open(str(OUTPUT_PATH), "w") as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        
        for i in range(num_samples):
            t = float(i) / sample_rate
            # Envolvente de ataque y decaimiento suave
            envelope = min(1.0, t * 2) * min(1.0, (duration_sec - t) * 2)
            # Combinación de armónicos
            value = 0.6 * math.sin(2.0 * math.pi * freq1 * t) + 0.3 * math.sin(2.0 * math.pi * freq2 * t)
            sample = int(value * envelope * 32767.0 * 0.5)
            data = struct.pack("<h", sample)
            wav_file.writeframesraw(data)
            
    print(f"[OK] Muestra de audio de prueba creada en: {OUTPUT_PATH}")

if __name__ == "__main__":
    generate_tone()
