<script setup lang="ts">
const { data: invoice } = await useFetch("/api/invoice", {
  query: { id: "inv-1001" },
});
</script>

<template>
  <main>
    <h1>Invocie {{ invoice?.id }}</h1>
    <p v-if="invoice">Total: {{ invoice.totalCents / 100 }} EUR</p>
    <PayButton :invoice-id="invoice?.id" />
  </main>
</template>
