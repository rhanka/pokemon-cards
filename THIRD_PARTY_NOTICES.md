# Third-party notices

## TCGdex cards database

CardScope uses catalogue metadata exposed by the
[TCGdex cards database](https://github.com/tcgdex/cards-database). The
enablement decision was reviewed against commit
`de58b67397b3c8d829e9cb7f4eba01a7a7346235`.

MIT License

Copyright (c) 2021 TCGdex

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

This notice covers TCGdex's database contribution. It does not grant rights to
Pokémon artwork, logos, trademarks, or third-party marketplace price feeds;
CardScope controls those data classes with separate disabled-by-default
switches.

## TheFusion21/PokemonCards — local experiment only

The local visual-retrieval intake may read the
[TheFusion21/PokemonCards](https://huggingface.co/datasets/TheFusion21/PokemonCards)
dataset card, which declares
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The dataset's
CSV points to external `images.pokemontcg.io` URLs. No image, weight, index, or
other derived artefact from this intake is committed or distributed by this
repository. Its upstream Pokémon artwork authority has not been independently
verified; the manifest therefore blocks public model publication and any
commercial use.
