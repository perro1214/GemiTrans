#!/usr/bin/env bash
#
# TranslateGemma の chat_template.jinja を GemiTrans 互換のものに書き換えるスクリプト
#
# 背景:
#   TranslateGemma の公式チャットテンプレートは content を
#   { type, source_lang_code, target_lang_code, text } の dict で要求するため、
#   OpenAI 互換 API (例: LM Studio) では送信できない。
#   本スクリプトはテンプレートを標準の OpenAI メッセージ形式 (content が文字列)
#   を受け付ける最小版に置き換える。GemiTrans 側の utils/lmstudio.js は
#   TranslateGemma の公式プロンプト文言そのものを content に詰めて送るため、
#   翻訳品質は維持される。
#
# 対応モデル:
#   mlx-community/translategemma-4b-it-4bit
#   mlx-community/translategemma-12b-it-*
#   mlx-community/translategemma-27b-it-*
#
# 使い方:
#   bash scripts/setup-lmstudio-template.sh
#

set -euo pipefail

MODELS_DIR="${HOME}/.lmstudio/models/mlx-community"

if [ ! -d "$MODELS_DIR" ]; then
    echo "エラー: $MODELS_DIR が見つかりません。LM Studio をインストールしてモデルをダウンロードしてください。" >&2
    exit 1
fi

shopt -s nullglob
found=0
for model_dir in "$MODELS_DIR"/translategemma-*; do
    if [ -f "$model_dir/chat_template.jinja" ]; then
        found=1
        echo "=> ${model_dir}"

        if [ ! -f "$model_dir/chat_template.jinja.original.bak" ]; then
            cp "$model_dir/chat_template.jinja" "$model_dir/chat_template.jinja.original.bak"
            echo "   原本を chat_template.jinja.original.bak に退避"
        fi

        cat > "$model_dir/chat_template.jinja" <<'JINJA'
{{ bos_token }}
{%- if (messages[0]['role'] != 'user') -%}
    {{ raise_exception("Conversations must start with a user prompt.") }}
{%- endif -%}
{%- for message in messages -%}
    {%- if (message['role'] == 'assistant') -%}
        {{ '<start_of_turn>model\n' + (message["content"] | trim) }}
    {%- elif (message['role'] == 'user') -%}
        {{ '<start_of_turn>user\n' + (message["content"] | trim) }}
    {%- else -%}
        {{ raise_exception("Conversations must only contain user or assistant roles.") }}
    {%- endif -%}
    {{ '<end_of_turn>\n' }}
{%- endfor -%}
{%- if add_generation_prompt -%}
    {{ '<start_of_turn>model\n' }}
{%- endif -%}
JINJA
        echo "   chat_template.jinja を GemiTrans 互換版に書き換えました"
    fi
done

if [ "$found" -eq 0 ]; then
    echo "警告: TranslateGemma モデルが見つかりませんでした。" >&2
    echo "      まず LM Studio でモデルをダウンロードしてください:" >&2
    echo "      lms get https://huggingface.co/mlx-community/translategemma-4b-it-4bit --mlx" >&2
    exit 1
fi

echo ""
echo "✅ 完了しました。LM Studio でモデルを再ロードしてください:"
echo "   lms unload --all && lms load translategemma-4b-it --ttl 3600 -y"
