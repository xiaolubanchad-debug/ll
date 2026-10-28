import { createApp } from 'vue';
import { ElAlert, ElButton, ElInput, ElInputNumber, ElTable, ElTableColumn } from 'element-plus';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/table/style/css';
import 'element-plus/es/components/table-column/style/css';
import App from './App.vue';
import './style.css';
createApp(App)
  .use(ElAlert)
  .use(ElButton)
  .use(ElInput)
  .use(ElInputNumber)
  .use(ElTable)
  .use(ElTableColumn)
  .mount('#app');
