<script setup lang="ts">
const props = defineProps<{ invoiceId?: string }>();

async function pay() {
  await $fetch("/api/pay", { method: "POST", body: { id: props.invoiceId } });
}
</script>

<template>
  <div class="pay" @click="pay">Pay now</div>
</template>

<style scoped>
.pay {
  background: #3b82f6;
  color: #fff;
  padding: 4px;
}
</style>
