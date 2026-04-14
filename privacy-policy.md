# Política de Privacidade — Cineminha

**Última atualização:** 14 de abril de 2026

## Resumo em uma frase

O Cineminha não coleta, armazena, vende ou compartilha nenhum dado pessoal dos seus usuários. A extensão funciona inteiramente com base em informações fornecidas voluntariamente pelo próprio usuário durante a sessão, e essas informações não são persistidas em nenhum servidor.

## Quem somos

O Cineminha é uma extensão gratuita e de código aberto para navegadores Chromium (Google Chrome, Microsoft Edge) que permite a um grupo de pessoas assistir vídeos em serviços de streaming de forma sincronizada, em tempo real, mesmo estando em locais geográficos diferentes.

## Que dados a extensão acessa

A extensão acessa apenas as seguintes informações, todas necessárias para o seu funcionamento:

**Dados fornecidos voluntariamente pelo usuário no painel da extensão:**
- Nome de exibição escolhido para a sala
- Avatar (emoji) e cor de identificação escolhidos
- Mensagens de texto digitadas no chat da sala
- Reações (emojis) enviadas durante a exibição
- Votos em enquetes criadas pelo host
- URL do servidor de sincronização (caso o usuário use um servidor próprio em vez do padrão)

**Dados técnicos da sessão de exibição, lidos da página de streaming aberta:**
- Estado do player de vídeo: tempo atual em segundos, se está pausado ou tocando
- URL da página atual (apenas para validar se é uma plataforma de streaming suportada e para sincronizar a navegação entre participantes da mesma sala)
- Eventos de play, pause e seek disparados pelo host

**Dados armazenados localmente no navegador (chrome.storage):**
- Preferências do usuário (nome, avatar, cor, configurações de som e notificação)
- Estado da sala ativa, para sobreviver a recargas de aba e suspensões do navegador
- URL do servidor de sincronização configurado

## O que a extensão NÃO coleta

- Nome real, e-mail, telefone, endereço ou qualquer outro dado de identificação pessoal
- Senhas, credenciais de login ou cookies de qualquer site
- Histórico de navegação fora das plataformas de streaming suportadas
- Histórico de quais filmes ou séries foram assistidos
- Localização geográfica
- Dados financeiros ou de pagamento
- Conteúdo da área de transferência (a extensão apenas escreve nela, nunca lê)
- Dados biométricos ou de saúde
- Comunicações pessoais fora do chat da própria sala
- Qualquer dado de outras abas que não sejam a aba do vídeo da sala atual

## Como os dados são usados

Os dados acima são usados exclusivamente para:

1. Sincronizar a reprodução do vídeo entre os participantes da mesma sala em tempo real
2. Exibir o nome e avatar de cada participante na lista da sala
3. Entregar mensagens de chat, reações e enquetes aos demais participantes da mesma sala
4. Salvar suas preferências entre sessões para que você não precise reconfigurar a cada uso
5. Permitir que você reentre em uma sala caso o navegador tenha suspendido temporariamente a extensão

Os dados nunca são usados para publicidade, perfilamento, análise comportamental, vendas ou qualquer finalidade não diretamente relacionada ao funcionamento da sala de exibição compartilhada.

## Como os dados trafegam

Eventos de sincronização e mensagens de chat trafegam através de um servidor WebSocket de retransmissão. Esse servidor:

- **Não armazena** nenhuma mensagem, evento, nome de usuário ou histórico em banco de dados, arquivo ou qualquer outra forma persistente
- **Apenas retransmite** as mensagens em memória RAM entre os participantes conectados na mesma sala, no momento exato em que elas são recebidas
- **Encerra a sala automaticamente** quando o último participante se desconecta, descartando todo o estado em memória
- **Não loga** o conteúdo das mensagens, IPs individuais ou metadados de uso

A conexão entre a extensão e o servidor usa o protocolo WSS (WebSocket Secure, criptografado via TLS).

Os usuários também têm a opção de hospedar o próprio servidor de retransmissão, configurando a URL nas opções da extensão. O código-fonte completo do servidor está disponível publicamente.

## Compartilhamento com terceiros

O Cineminha não compartilha dados com nenhum terceiro. Não há integração com plataformas de analytics, redes de anúncios, brokers de dados, redes sociais ou qualquer outro serviço externo. A extensão também não vende nem aluga dados a ninguém, sob nenhuma circunstância.

A única comunicação externa que a extensão realiza é com o servidor WebSocket de retransmissão configurado pelo usuário, exclusivamente para sincronização da sala.

## Plataformas de streaming

A extensão acessa o conteúdo de páginas das seguintes plataformas, exclusivamente para detectar o elemento de vídeo HTML5 e aplicar comandos de play, pause e seek:

- Netflix
- YouTube
- Disney+
- Amazon Prime Video
- Max (HBO Max)
- Globoplay
- Crunchyroll

A extensão não contorna proteção de DRM, não permite compartilhamento de contas, não baixa nem retransmite conteúdo de vídeo. Cada participante de uma sala precisa ter a própria assinatura ativa do serviço correspondente.

## Crianças

A extensão não é direcionada a crianças menores de 13 anos e não coleta intencionalmente dados de menores. Como nenhum dado pessoal é coletado de qualquer usuário, independentemente de idade, a extensão está em conformidade com a COPPA (Children's Online Privacy Protection Act) e legislações equivalentes.

## Seus direitos

Como nenhum dado pessoal é coletado ou armazenado pelo desenvolvedor da extensão, não há dados para acessar, corrigir, exportar ou excluir. As preferências e o estado da sala armazenados localmente no seu navegador podem ser apagados a qualquer momento desinstalando a extensão ou limpando o storage do site nas configurações do navegador.

## Mudanças nesta política

Caso esta política seja atualizada, a nova versão será publicada nesta mesma URL e a data no topo do documento será atualizada. Mudanças significativas serão comunicadas através da descrição da extensão na Chrome Web Store.

## Contato

Para dúvidas sobre esta política de privacidade ou sobre o tratamento de dados pela extensão, entre em contato através do repositório do projeto no GitHub ou pelo e-mail de suporte listado na página da extensão na Chrome Web Store.
