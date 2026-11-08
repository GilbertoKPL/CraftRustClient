# MAtmos no CraftRust

As regras e os caminhos vêm dos pacotes MAtmos abaixo. Na biblioteca ativa,
os efeitos e ambientes com equivalentes foram substituídos por Enhanced Audio;
consulte `../enhanced-audio.json` e [a biblioteca sonora](../README.md). Os hashes
de `manifest.json` representam os arquivos ativos. As licenças em `licenses/`
referem-se apenas aos arquivos MAtmos preservados.

A importação MAtmos original continha 188 arquivos Ogg dos pacotes:

- MAtmos 2020 Zen **35-1.2.2**, por makamys: 33 arquivos, incluindo o arquivo de silêncio do pacote.
- MAtmos Default 2016 **36-1.3**, originalmente por Hurricaaane: 155 arquivos.

Os links, versões e SHA-256 das distribuições e de cada arquivo estão em
`manifest.json`. `licenses/` conserva os avisos de autoria e licença disponíveis
nos projetos de origem. Esses arquivos são um pacote separado da biblioteca CC0
original do CraftRust; a declaração de licença dessa biblioteca não se aplica
automaticamente aos sons do MAtmos.

## Uso

Ativado por padrão no cliente nativo (Vulkan/OpenGL) e no navegador. Os sete
controles de expansão ficam junto dos demais volumes em **Opções → Música e sons**.
**F4** abre essa mesma tela. Zero desliga a expansão. Volumes ficam salvos em `options.txt`.
Os canais gerais de Ambiente, Clima e Jogadores continuam sendo aplicados.

`resources/matmos-rules.json` conserva as condições, grupos, máquinas, tempos,
variações e referências dos bancos originais. A engine avalia ações a 20 Hz e
amostra o terreno duas vezes por segundo. Interior, abrigo profundo, exposição
à chuva, vegetação, água, gelo, altitude, hora, clima e dimensão vêm do mundo
local. Os scanners foram adaptados aos chunks do CraftRust; não executam o
código Java nem reproduzem exatamente os scanners de flood-fill do Minecraft.

Os loops usam uma única voz por máquina/camada, com fades de entrada/saída,
descarte ao sair do mundo e proteção contra cargas atrasadas no navegador.
O cliente nativo usa decodificação Vorbis contínua, sem carregar loops completos
na memória. A versão web usa o cache limitado de buffers já existente.

Os efeitos de interface usam os sinais do pacote clássico. Troca de itens,
espadas, ferramentas, arco, água, movimento e tochas usam as regras dos pacotes.
Carrinhos usam o mixer posicional existente com as gravações MAtmos, evitando
dois motores tocando sobrepostos. Splash e queda reutilizam seus gatilhos
existentes com as gravações substitutas. A música original do cliente permanece.

Os pacotes originais contêm dois nomes de condição sem definição; a adaptação
define `Random 1mins 20%` e `Interact Target` conforme seus sensores correspondentes.
Rhapsodia é outro pacote opcional e não está incluído nesta integração.

## Reproduzir a importação e verificar

```powershell
python tools/import-matmos.py
python tools/test-matmos.py
node tools/test-web-audio.mjs
cargo test -p craftrust-client --no-default-features --lib audio::
```

A importação baixa somente as duas distribuições fixadas, verifica o hash antes
de extrair e copia os Ogg sem modificações. O jogo não faz downloads externos.
Regenerar a biblioteca base com `tools/generate-audio.py --install` preserva
o pacote MAtmos.
