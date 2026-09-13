from transformers import AutoModel, AutoModelForCausalLM

model = AutoModel.from_pretrained("gpt2")

lm = AutoModelForCausalLM.from_pretrained("openai-community/gpt2")

