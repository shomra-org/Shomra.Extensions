# Open this file with the Shomra extension active (and the `shomra` CLI enrolled,
# or SHOMRA_URL pointing at your backend). On save, the model loads below are
# looked up in the Shomra Model Index; known-vulnerable ones get a squiggle on
# the load line with a "View model in the Model Index" quick-fix.
from transformers import AutoModel, AutoModelForCausalLM

# Bare short id — the common form. Resolves to openai-community/gpt2.
model = AutoModel.from_pretrained("gpt2")

# Canonical org-scoped id — the same model.
lm = AutoModelForCausalLM.from_pretrained("openai-community/gpt2")

