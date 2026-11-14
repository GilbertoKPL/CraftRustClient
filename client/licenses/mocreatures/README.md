# Mo'Creatures no CraftRust

Integração nativa das **90 criaturas registradas** em
[multision/mocreaturesdev](https://github.com/multision/mocreaturesdev).
O commit exato, os autores, os arquivos usados e seus hashes estão em
[`../provenance/mocreatures.json`](../provenance/mocreatures.json).
As criaturas fazem parte da base; Java e Forge não são dependências do jogo.

## Disponível

- Cadastro, ovos individuais no criativo, nomes em português no HUD e minimapa.
- Geometria dos construtores originais, texturas e sons disponíveis no upstream.
- Vida, dimensões, dano, movimentação terrestre, aquática ou aérea e IA comum.
- Invocação por comando, ovos, dispensadores, spawners e salvamento.
- Spawn por categoria, luz, bioma e dimensão, respeitando os limites existentes.
- Modelos e texturas compartilhados entre PC e WebAssembly.

Exemplos: `/summon mocreatures:lion`, `/summon mocreatures:shark`,
`/summon mocreatures:butterfly` e `/summon mocreatures:wyvern`.
Os identificadores completos estão no catálogo abaixo. O prefixo interno `mo_`
mantém espécies do mod separadas dos animais que já existiam no CraftRust.

Os tags de bioma do Forge foram traduzidos para os biomas disponíveis na base.
O Wyvern Lair usa um gerador nativo de ilhas, quatro biomas e materiais próprios.
O cajado `mocreatures:staffportal` cria/carrega o mundo e guarda a posição de retorno.

Amostra visual da geometria nativa: [`preview.png`](preview.png). As criaturas estão
em escalas ajustadas por quadro para comparação de aparência, com iluminação
simplificada. Galeria completa: [1–30](catalog-1.png), [31–60](catalog-2.png),
[61–90](catalog-3.png). Para reconstruir:
`cargo run -p craftrust-client --example mob_catalog_preview --no-default-features`.

## Comportamentos e interações

- Alimentação, domesticação, sexo, filhotes naturais, montaria terrestre/aquática/aérea e inventário persistente.
- Gestação, híbridos de felinos e tabela original de 53 pares de genética dos cavalos.
- Lobisomem com forma humana diurna, transformação noturna e resistência à prata.
- Venenos por variante, náusea, cegueira e lentidão com apresentação no cliente; efeitos acompanham o jogador entre regiões.
- Ogros com ataque carregado; golens coletam e arremessam blocos reais, respeitando proteção e `mobGriefing`.
- Caça, comida no chão, furto de itens caídos, amuletos/redes e incubação de ovos.
- Filhotes de escorpião, essências/evolução de montarias, selas, armaduras, presas e acessórios de elefantes.
- Camas com comida/leite e caixas de areia para gatos; 268 combinações de aparência e armaduras texturizadas.
- 152 itens, 27 blocos, 124 receitas de fabricação, 22 receitas de forno e tabelas originais de loot.

É uma adaptação nativa; os controladores Java/Forge não são executados. A geração
não reproduz bloco a bloco a dimensão Java. Ainda não há paridade de todos os
estados e interações por espécie: furto direto do inventário do jogador, defesa
coordenada dos pets, detalhes de ecologia/ent e todos os bônus de conjuntos de
armadura permanecem fora da implementação atual. A presença de uma espécie no
catálogo não comprova equivalência integral de IA. O acompanhamento está em
[IA_PROGRESS.md](IA_PROGRESS.md).

O próprio upstream declara alguns sons que não existem no seu `sounds.json`.
Esses eventos ficam silenciosos e aparecem em `unavailable_upstream_sounds`
no manifesto, sem apontar para arquivos inexistentes.

## Reconstruir

Requer Python com Pillow, Git e um JDK com `javac` e `java`:

```powershell
git clone https://github.com/multision/mocreaturesdev.git target/mocreatures-source
git -C target/mocreatures-source checkout fe18dea38d8f402af7345b54d3fef8ef841173c4
python resources/mocreatures/import.py --source target/mocreatures-source
```

O importador executa apenas os construtores dos modelos contra um gravador de
geometria. Preserva pivôs, rotações, hierarquias, UVs e espelhamento; seleciona
variantes e acessórios condicionais ao estado autoritativo. Os arquivos intermediários
ficam em `target/mocreatures-bake`.

O atlas continua com 4096 × 8192 pixels. Células de mobs comuns passam a representar
32 pixels lógicos, mantendo as folhas de cabeças e lã em seu formato anterior.
As imagens existentes que tinham sido ampliadas são instaladas na sua resolução
nativa. As folhas do MoCreatures usam células de 64 pixels lógicos. São 1475 das 1536 células reservadas, incluindo variantes, itens, materiais, armaduras e mobiliário.

Os resultados e as falhas observadas na suíte geral estão em
[VALIDACAO.md](VALIDACAO.md).

## Licença e créditos

O repositório de origem declara **GNU GPL v3**. O texto integral está em
[`COPYING`](COPYING). DrZhark, BlockDaddy e Bloodshot são os autores históricos;
multision, TheidenHD, ACGaming, IcarussOne e xJon recebem os créditos registrados
pelo projeto de origem.
O modelo do lagarto furtivo também contém crédito e aviso de permissão de Daveyx0.

`../provenance/mocreatures-java-source.zip` conserva o código Java original e seus
avisos, além dos arquivos de build e README. As texturas e os áudios importados
permanecem atribuídos aos autores de origem; não são arte original do CraftRust.
As alterações desta adaptação estão nos fontes Rust, no importador e nos catálogos.

Ao distribuir uma versão derivada, mantenha licença e créditos e disponibilize o
código-fonte correspondente da versão distribuída conforme a GPL, incluindo as
alterações e os arquivos necessários à construção. O ZIP do Java original, sozinho,
não substitui o código correspondente da versão modificada do CraftRust.

## Catálogo

<!-- generated-catalog -->

| Criatura | Identificador | Spawn natural |
| --- | --- | --- |
| Pássaro | `mocreatures:bird` | Sim |
| Urso-negro | `mocreatures:bear` | Sim |
| Javali | `mocreatures:boar` | Sim |
| Coelho selvagem | `mocreatures:bunny` | Sim |
| Crocodilo | `mocreatures:crocodile` | Sim |
| Pato | `mocreatures:duck` | Sim |
| Cervo | `mocreatures:deer` | Sim |
| Elefante | `mocreatures:elephant` | Sim |
| Ent | `mocreatures:ent` | Sim |
| Lagarto furtivo | `mocreatures:filch_lizard` | Sim |
| Raposa | `mocreatures:fox` | Sim |
| Cabra | `mocreatures:goat` | Sim |
| Urso-pardo | `mocreatures:grizzly_bear` | Sim |
| Gato | `mocreatures:kitty` | Sim |
| Dragão-de-komodo | `mocreatures:komodo_dragon` | Sim |
| Leoger | `mocreatures:leoger` | Ovo/comando |
| Leopardo | `mocreatures:leopard` | Sim |
| Liard | `mocreatures:liard` | Ovo/comando |
| Leão | `mocreatures:lion` | Sim |
| Ligre | `mocreatures:liger` | Ovo/comando |
| Lither | `mocreatures:lither` | Ovo/comando |
| Mantícora domesticável | `mocreatures:manticore_pet` | Ovo/comando |
| Toupeira | `mocreatures:mole` | Sim |
| Camundongo | `mocreatures:mouse` | Sim |
| Avestruz | `mocreatures:ostrich` | Sim |
| Panda | `mocreatures:panda_bear` | Sim |
| Panthard | `mocreatures:panthard` | Ovo/comando |
| Pantera | `mocreatures:panther` | Sim |
| Panthger | `mocreatures:panthger` | Ovo/comando |
| Escorpião domesticável | `mocreatures:pet_scorpion` | Ovo/comando |
| Urso-polar | `mocreatures:polar_bear` | Sim |
| Guaxinim | `mocreatures:raccoon` | Sim |
| Serpente | `mocreatures:snake` | Sim |
| Tigre | `mocreatures:tiger` | Sim |
| Tartaruga | `mocreatures:turtle` | Sim |
| Peru | `mocreatures:turkey` | Sim |
| Cavalo selvagem | `mocreatures:wildhorse` | Sim |
| Serpe alada | `mocreatures:wyvern` | Ovo/comando |
| Ogro das cavernas | `mocreatures:cave_ogre` | Sim |
| Espectro flamejante | `mocreatures:flame_wraith` | Sim |
| Ogro de fogo | `mocreatures:fire_ogre` | Sim |
| Ogro verde | `mocreatures:green_ogre` | Sim |
| Grande golem | `mocreatures:big_golem` | Sim |
| Cavalo sombrio | `mocreatures:horsemob` | Sim |
| Rato infernal | `mocreatures:hellrat` | Sim |
| Mantícora sombria | `mocreatures:dark_manticore` | Sim |
| Mantícora de fogo | `mocreatures:fire_manticore` | Sim |
| Mantícora glacial | `mocreatures:frost_manticore` | Sim |
| Mantícora das planícies | `mocreatures:plain_manticore` | Sim |
| Mantícora tóxica | `mocreatures:toxic_manticore` | Sim |
| Pequeno golem | `mocreatures:mini_golem` | Sim |
| Rato | `mocreatures:rat` | Sim |
| Esqueleto de prata | `mocreatures:silver_skeleton` | Sim |
| Escorpião das cavernas | `mocreatures:cave_scorpion` | Sim |
| Escorpião da terra | `mocreatures:dirt_scorpion` | Sim |
| Escorpião glacial | `mocreatures:frost_scorpion` | Sim |
| Escorpião de fogo | `mocreatures:fire_scorpion` | Sim |
| Escorpião morto-vivo | `mocreatures:undead_scorpion` | Sim |
| Lobisomem | `mocreatures:werewolf` | Sim |
| Espectro | `mocreatures:wraith` | Sim |
| Lobo selvagem | `mocreatures:wwolf` | Sim |
| Anchova | `mocreatures:anchovy` | Sim |
| Peixe-anjo | `mocreatures:angelfish` | Sim |
| Peixe-pescador | `mocreatures:angler` | Sim |
| Achigã | `mocreatures:bass` | Sim |
| Peixe-palhaço | `mocreatures:clownfish` | Sim |
| Bacalhau | `mocreatures:cod` | Sim |
| Golfinho | `mocreatures:dolphin` | Sim |
| Peixe tropical | `mocreatures:fishy` | Sim |
| Peixe-dourado | `mocreatures:goldfish` | Sim |
| Peixe-cirurgião | `mocreatures:hippotang` | Sim |
| Água-viva | `mocreatures:jellyfish` | Sim |
| Peixe-mandarim | `mocreatures:manderin` | Sim |
| Piranha | `mocreatures:piranha` | Sim |
| Salmão | `mocreatures:salmon` | Sim |
| Arraia-manta | `mocreatures:mantaray` | Sim |
| Tubarão | `mocreatures:shark` | Sim |
| Arraia de ferrão | `mocreatures:stingray` | Sim |
| Formiga | `mocreatures:ant` | Sim |
| Abelha | `mocreatures:bee` | Sim |
| Borboleta | `mocreatures:butterfly` | Sim |
| Caranguejo | `mocreatures:crab` | Sim |
| Grilo | `mocreatures:cricket` | Sim |
| Libélula | `mocreatures:dragonfly` | Sim |
| Vaga-lume | `mocreatures:firefly` | Sim |
| Mosca | `mocreatures:fly` | Sim |
| Gafanhoto | `mocreatures:grasshopper` | Sim |
| Larva | `mocreatures:maggot` | Sim |
| Caracol | `mocreatures:snail` | Sim |
| Barata | `mocreatures:roach` | Sim |
