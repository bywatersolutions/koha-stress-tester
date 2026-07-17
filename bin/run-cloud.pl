#!/usr/bin/perl

# run-cloud.pl - Interactive: stand up a partner's stress-test project on Grafana
# Cloud and run its tests. Prompts for everything; the ONLY thing you store is
# the GRAFANA_CLOUD_K6_PERSONAL_API_TOKEN environment variable.
#
# Usage:
#   export GRAFANA_CLOUD_K6_PERSONAL_API_TOKEN=<token from the k6 app>
#   ./bin/run-cloud.pl
#
# It asks for the partner, the platform ( Aspen + Koha, or Koha-only ), the URLs
# and load targets ( only the ones the platform needs ), then lets you pick which
# test to run. Each test runs via 'k6 cloud run', so it is re-runnable from the
# k6 UI's Run button afterward. Credentials are NOT prompted - the login password
# and ingress token come from the org-wide Grafana secrets.
#
# On a re-run the prompts default to the values already baked into the project's
# tests, so you just press Enter through.

use Modern::Perl;
use FindBin;
use HTTP::Tiny;
use JSON::PP;
use File::Temp qw(tempfile);

my $API         = "https://api.k6.io";
my $NAME_PREFIX = "Stress Testing - ";

# The one stored thing.
my $token = $ENV{GRAFANA_CLOUD_K6_PERSONAL_API_TOKEN};
unless ( defined $token && length $token ) {
    die "Set your k6 personal API token first ( the only thing you store ):\n"
      . "  export GRAFANA_CLOUD_K6_PERSONAL_API_TOKEN=<token>\n"
      . "Get it from the k6 app: your avatar -> Personal API token.\n";
}
my $http = HTTP::Tiny->new;

# Per-platform config, prompted and passed to each run. 'mode' = which platform
# the var applies to ( both / aspen / opac ). Credentials are excluded - they
# come from the org secrets.
my @CONFIG_VARS = (
    { name => 'STAFF_URL',                   mode => 'both',  desc => 'Staff interface base URL (login + Daily Operations + API)',           default => 'https://staff.example.org' },
    { name => 'STAFF_USER',                  mode => 'both',  desc => 'Superlibrarian username for the login-based tests',                   default => 'bwssupport' },
    { name => 'OPAC_URL',                    mode => 'opac',  desc => 'Public catalog (OPAC) base URL - patrons search it directly',         default => 'https://catalog.example.org' },
    { name => 'ASPEN_BASE_URL',              mode => 'aspen', desc => 'Aspen Discovery base URL - the patron catalog',                       default => 'https://discovery.example.org' },
    { name => 'OPAC_SEARCHES_PER_HOUR',      mode => 'opac',  desc => 'Peak OPAC catalog searches per hour to sustain',                      default => '5000', num => 1 },
    { name => 'ASPEN_SEARCHES_PER_HOUR',     mode => 'aspen', desc => 'Peak Aspen catalog searches per hour to sustain',                     default => '5000', num => 1 },
    { name => 'PATRON_SESSIONS_PER_HOUR',    mode => 'aspen', desc => 'Patron sessions/hour (Aspen->Koha API load, Daily Operations)',       default => '2000', num => 1 },
    { name => 'STAFF_TRANSACTIONS_PER_HOUR', mode => 'both',  desc => 'Staff transactions per hour (Daily Operations test)',                 default => '1000', num => 1 },
    { name => 'TRAINING_ATTENDEES',          mode => 'both',  desc => 'Training class size (number of attendees)',                           default => '50', num => 1 },
    { name => 'CATALOG_SEARCH_TERM',         mode => 'both',  desc => 'A search term with hits in the target catalog',                       default => 'harry potter' },
);

# script -> friendly cloud test name, and the per-platform test sets.
my %TEST_NAME = (
    'koha_opac_http.js'         => 'OPAC Stress Test - HTTP Only',
    'koha_opac_browser.js'      => 'OPAC Stress Test - Browser',
    'koha_steady_state.js'      => 'Daily Operations',
    'koha_training_protocol.js' => 'Training Simulation - HTTP Only',
    'koha_training_browser.js'  => 'Training Simulation - End to End',
    'aspen_http.js'             => 'Aspen Stress Test - HTTP Only',
    'aspen_browser.js'          => 'Aspen Stress Test - Browser',
);
my %TEST_SETS = (
    aspen => [qw( aspen_http.js aspen_browser.js koha_steady_state.js koha_training_protocol.js koha_training_browser.js )],
    opac  => [qw( koha_opac_http.js koha_opac_browser.js koha_steady_state.js koha_training_protocol.js koha_training_browser.js )],
);

my $org = _discover_org();

# --- partner -> project ( resolve by name, or create ) ---
my $partner = _read_line( "Partner name ( e.g. PWPL ): ", "" );
$partner =~ s/^\s+|\s+$//g;
die "A partner name is required.\n" unless length $partner;
my $project_name = $partner =~ /^\Q$NAME_PREFIX\E/ ? $partner : "$NAME_PREFIX$partner";
my $pid = _resolve_or_create_project( $org, $project_name );

# --- platform ---
say "";
say "Platform:";
say "  Aspen + Koha - patrons search Aspen; the Koha OPAC is hit only by the Aspen API";
say "  Koha-only    - patrons search the Koha OPAC directly";
my $pa = _read_line( "  Use Aspen Discovery in front of Koha? [Y/n]: ", "Y" );
my $platform = ( $pa =~ /^\s*n/i ) ? 'opac' : 'aspen';
my $platform_label = $platform eq 'aspen' ? 'Aspen + Koha' : 'Koha-only';

# --- config ( defaults pre-filled from the project's existing tests ) ---
my $deployed = _deployed_defaults($pid);
my %settings;
say "";
say "Settings for $project_name [$platform_label] ( Enter to accept the default ):";
for my $v ( _vars_for($platform) ) {
    my $def = ( defined $deployed->{ $v->{name} } && length $deployed->{ $v->{name} } )
        ? $deployed->{ $v->{name} }
        : $v->{default};
    while (1) {
        say "";
        say "  $v->{name} - $v->{desc}";
        my $val = _read_line( "    [$def]: ", $def );
        $val =~ s/^\s+|\s+$//g;
        if ( $v->{num} && $val !~ /^-?\d+(?:\.\d+)?$/ ) { say "    ! must be a number"; next; }
        $settings{ $v->{name} } = $val;
        last;
    }
}

# --- pick a test ( or all ) ---
my @tests = @{ $TEST_SETS{$platform} };
say "";
say "Which test to run?";
say "  1) all";
my $n = 2;
for my $s (@tests) { say "  $n) $TEST_NAME{$s}"; $n++; }
my $pick = _read_line( "  Choice [1]: ", "1" );
$pick =~ s/\D//g;
$pick = 1 unless length $pick;
my @chosen = $pick == 1 ? @tests : ( $tests[ $pick - 2 ] // () );
die "No such choice.\n" unless @chosen;

# --- run each via k6 cloud run ( UI-runnable; secrets from the org ) ---
for my $script (@chosen) {
    _run_cloud( $script, $pid, $platform, \%settings );
}

# ------------------------------------------------------------

sub _vars_for {
    my ($p) = @_;
    return grep { $_->{mode} eq 'both' || $_->{mode} eq $p } @CONFIG_VARS;
}

sub _api {
    my ( $method, $url, $body ) = @_;
    my %opts = ( headers => { Authorization => "Bearer $token" } );
    if ( defined $body ) {
        $opts{headers}{'Content-Type'} = 'application/json';
        $opts{content} = encode_json($body);
    }
    return $http->request( $method, $url, \%opts );
}

sub _discover_org {
    my $res = _api( 'GET', "$API/v3/organizations" );
    die "Could not reach the k6 API ( HTTP $res->{status} ) - check the token.\n"
        unless $res->{success};
    my $orgs = decode_json( $res->{content} )->{organizations} || [];
    die "No organizations for this token.\n" unless @$orgs;
    return $orgs->[0]{id};
}

# Find the project by exact name, else create it. Returns the id.
sub _resolve_or_create_project {
    my ( $org, $name ) = @_;
    my $res = _api( 'GET', "$API/cloud/v5/projects?organization_id=$org" );
    if ( $res->{success} ) {
        my $list     = decode_json( $res->{content} );
        my $projects = $list->{value} || $list->{projects} || [];
        for my $p (@$projects) {
            if ( ( $p->{name} // '' ) eq $name ) {
                say "Using project '$name' ( id $p->{id} )";
                return $p->{id};
            }
        }
    }
    my $c = _api( 'POST', "$API/v3/projects", { name => $name, organization_id => int($org) } );
    die "Could not create project '$name' ( HTTP $c->{status} ): " . _short( $c->{content} ) . "\n"
        unless $c->{success};
    my $pid = decode_json( $c->{content} )->{project}{id}
        or die "Project created but no id returned.\n";
    say "Created project '$name' ( id $pid )";
    return $pid;
}

# Best-effort: read each config var's currently-baked value from the project's
# existing tests, so the prompts default to what's already there on a re-run.
sub _deployed_defaults {
    my ($pid) = @_;
    my %vals;
    my $res = _api( 'GET', "$API/loadtests/v2/tests?project_id=$pid&page_size=100" );
    return \%vals unless $res->{success};
    my $data = decode_json( $res->{content} );
    for my $t ( @{ $data->{'k6-tests'} || [] } ) {
        my $tt     = $t->{'k6-test'} // $t;
        my $one    = _api( 'GET', "$API/loadtests/v2/tests/$tt->{id}" );
        next unless $one->{success};
        my $script = ( decode_json( $one->{content} )->{'k6-test'} // {} )->{script} // '';
        for my $v (@CONFIG_VARS) {
            next if defined $vals{ $v->{name} };
            my $ev = quotemeta( $v->{name} );
            if    ( $script =~ /__ENV\.$ev\s*\|\|\s*"([^"]*)"/ )                 { $vals{ $v->{name} } = $1; }
            elsif ( $script =~ /__ENV\.$ev\)\s*\|\|\s*(-?[0-9]+(?:\.[0-9]+)?)/ ) { $vals{ $v->{name} } = $1; }
        }
    }
    return \%vals;
}

# Run one test via 'k6 cloud run' with the prompted settings. PATRON_MODE comes
# from the platform. Secrets are NOT passed - they resolve from the org secrets.
# k6 authenticates with our token via K6_CLOUD_TOKEN, so no 'k6 cloud login'
# is needed.
sub _run_cloud {
    my ( $script, $pid, $platform, $settings ) = @_;
    my $name = $TEST_NAME{$script} // ( $script =~ s/\.js$//r );
    my $path = "$FindBin::Bin/../benchmarks/$script";
    unless ( -f $path ) { say "SKIP $name ( $script not found )"; return; }

    # Bake the settings + PATRON_MODE into a temp copy of the script, so the
    # uploaded archive carries the partner config in the script itself - the UI
    # Run button and this tool's re-run prefill both read it back. Only vars the
    # user gave a value for are baked; secrets are never here ( they resolve
    # from the org-wide Grafana secrets at run time ).
    my %bake = ( PATRON_MODE => $platform );
    for my $v ( _vars_for($platform) ) {
        my $val = $settings->{ $v->{name} };
        $bake{ $v->{name} } = $val if defined $val && length $val;
    }
    my $baked = _bake( _slurp($path), \%bake );
    my ( $fh, $tmp ) = tempfile( "runcloud-XXXXXX", SUFFIX => '.js', TMPDIR => 1 );
    print $fh $baked;
    close $fh;

    say "";
    say "=" x 52;
    say "Running: $name   ( project $pid )";
    say "  ( re-runnable from the UI Run button once this finishes )";
    say "=" x 52;
    local $ENV{K6_CLOUD_TOKEN} = $token;
    system( 'k6', 'cloud', 'run', '-e', "CLOUD_PROJECT_ID=$pid", '-e', "CLOUD_TEST_NAME=$name", $tmp );
    unlink $tmp;
}

sub _slurp {
    my ($p) = @_;
    open my $fh, '<', $p or die "read $p: $!\n";
    local $/;
    return <$fh>;
}

# Rewrite each "__ENV.VAR || default" with the given value ( string form
# __ENV.VAR || "..." and numeric form parse*(__ENV.VAR) || 123 ). A var not
# present in a script is left untouched. ( same rewrite as sync-cloud-tests.pl )
sub _bake {
    my ( $script, $overrides ) = @_;
    for my $var ( keys %$overrides ) {
        my $val = $overrides->{$var};
        next unless defined $val;
        my $ev = quotemeta($var);
        my $q  = $val;
        $q =~ s/(["\\])/\\$1/g;
        $script =~ s/(__ENV\.$ev\s*\|\|\s*)"[^"]*"/$1"$q"/g;
        $script =~ s/(__ENV\.$ev\)\s*\|\|\s*)-?[0-9]+(?:\.[0-9]+)?/$1$val/g;
    }
    return $script;
}

sub _short { my ($s) = @_; $s //= ''; $s =~ s/\s+/ /g; return substr( $s, 0, 200 ); }

# Read one line with basic editing ( left/right arrows, Home/End, backspace,
# Ctrl-A/E/U ) by driving the terminal in raw mode - a plain <STDIN> read is
# canonical-mode, which passes arrow keys through as "^[[D" etc. Falls back to a
# plain read when stdin/stdout isn't a terminal.
sub _read_line {
    my ( $prompt, $default ) = @_;

    unless ( -t STDIN && -t STDOUT ) {
        print $prompt;
        my $in = <STDIN>;
        return $default unless defined $in;
        chomp $in;
        return length $in ? $in : $default;
    }

    local $| = 1;
    my $saved = `stty -g 2>/dev/null`;
    chomp $saved;
    system( "stty", "-icanon", "-echo", "min", "1", "time", "0" );
    my $restore = sub { system( "stty", $saved ) if length $saved };
    local $SIG{INT} = sub { $restore->(); print "\n"; exit 130 };

    my @buf;
    my $pos  = 0;
    my $draw = sub {
        print "\r\e[K", $prompt, join( '', @buf );
        my $back = @buf - $pos;
        print "\e[${back}D" if $back > 0;
    };

    my $err;
    eval {
        $draw->();
        my $c;
        while ( sysread( STDIN, $c, 1 ) ) {
            if    ( $c eq "\n" || $c eq "\r" )     { last }
            elsif ( $c eq "\x7f" || $c eq "\x08" ) { splice( @buf, --$pos, 1 ) if $pos > 0 }
            elsif ( $c eq "\x03" )                 { $restore->(); print "\n"; exit 130 }
            elsif ( $c eq "\x15" )                 { @buf = (); $pos = 0 }
            elsif ( $c eq "\x01" )                 { $pos = 0 }
            elsif ( $c eq "\x05" )                 { $pos = @buf }
            elsif ( $c eq "\e" ) {
                sysread( STDIN, my $b, 1 ) or next;
                next unless $b eq '[';
                sysread( STDIN, my $k, 1 ) or next;
                if    ( $k eq 'D' ) { $pos-- if $pos > 0 }
                elsif ( $k eq 'C' ) { $pos++ if $pos < @buf }
                elsif ( $k eq 'H' ) { $pos = 0 }
                elsif ( $k eq 'F' ) { $pos = @buf }
                elsif ( $k eq '3' ) { sysread( STDIN, my $t, 1 ); splice( @buf, $pos, 1 ) if $pos < @buf }
            }
            elsif ( $c ge ' ' ) { splice( @buf, $pos, 0, $c ); $pos++ }
            $draw->();
        }
        1;
    } or $err = $@;

    $restore->();
    print "\n";
    die $err if $err;

    my $val = join( '', @buf );
    return length $val ? $val : $default;
}
